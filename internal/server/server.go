// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package server 是对外的那一层：Claude Code 说 Anthropic 的 Messages 协议，
// 这里负责鉴权、路由、把请求交给对应的来源，再把上游的 OpenAI 分片翻成 Anthropic 事件。
//
// 它与翻译层之间只隔一层函数钩子（Hooks）：翻译层是纯函数（internal/anthropic），
// 这里只关心「谁来翻」，于是测试可以用假钩子，不必起上游。
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/9Ashwin/claude-code-openai-bridge/errs"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/config"
	"github.com/9Ashwin/claude-code-openai-bridge/internal/source"
)

// TranslateOptions 是交给翻译层的上下文。
type TranslateOptions struct {
	Model        string
	MaxTokensCap int
	// Rewriter 是内容风控改写器：**只有腾讯系来源非 nil**（套餐分离不变式）。
	Rewriter     source.Rewriter
	ShowThinking bool
}

// Hooks 是翻译层的四件事。由 cmd 层接线到 internal/anthropic。
type Hooks struct {
	// ToOpenAI 把 Anthropic 请求体翻成 OpenAI 请求体。
	ToOpenAI func(body []byte, opts TranslateOptions) ([]byte, error)
	// Stream 把上游分片流翻成 Anthropic SSE 事件写进 w。
	Stream func(w io.Writer, stream source.Stream, opts TranslateOptions) error
	// Message 把上游分片流归并成一条 Anthropic 消息 JSON。
	Message func(stream source.Stream, opts TranslateOptions) ([]byte, error)
	// EstimateTokens 本地估算 input tokens（count_tokens 用）。
	EstimateTokens func(body []byte) int
}

// Options 是起服务的全部输入。
type Options struct {
	Host        string
	Port        int
	APIKey      string
	Model       string
	HeartbeatMs int
	// ShowThinking 为真时把上游的推理内容也翻成 thinking 块。
	ShowThinking bool
	// MaxTokensCap 为 0 表示不额外限制。
	MaxTokensCap int
	Registry     *source.Registry
	Hooks        Hooks
	Log          func(format string, args ...any)
}

// Server 是桥的 HTTP 服务。
type Server struct {
	opts Options
	http *http.Server
}

// New 组装路由。
func New(opts Options) *Server {
	if opts.Log == nil {
		opts.Log = func(string, ...any) {}
	}
	if opts.HeartbeatMs <= 0 {
		opts.HeartbeatMs = 5000
	}
	server := &Server{opts: opts}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", server.handleHealth)
	mux.HandleFunc("/v1/models", server.handleModels)
	mux.HandleFunc("/v1/messages", server.handleMessages)
	mux.HandleFunc("/v1/messages/count_tokens", server.handleCountTokens)
	server.http = &http.Server{
		Addr:              fmt.Sprintf("%s:%d", opts.Host, opts.Port),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return server
}

// Handler 暴露给测试直接调用（不必真的监听端口）。
func (s *Server) Handler() http.Handler { return s.http.Handler }

// ListenAndServe 起服务；ctx 取消时优雅关闭。
func (s *Server) ListenAndServe(ctx context.Context) error {
	listener, err := net.Listen("tcp", s.http.Addr)
	if err != nil {
		return err
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = s.http.Shutdown(shutdownCtx)
	}()
	err = s.http.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// ── 鉴权 ────────────────────────────────────────────────────────────────────

// authorized 校验 `x-api-key` 或 `Bearer`。
//
// 用恒定时间比较：本地服务也不该让密钥能被逐字节试探出来。
func (s *Server) authorized(r *http.Request) bool {
	if s.opts.APIKey == "" {
		return true
	}
	provided := r.Header.Get("x-api-key")
	if provided == "" {
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			provided = strings.TrimPrefix(auth, "Bearer ")
		}
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(s.opts.APIKey)) == 1
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// anthropicError 是 Anthropic 形状的错误信封：客户端认这个形状才会显示可读信息。
func anthropicError(w http.ResponseWriter, status int, kind, message string) {
	writeJSON(w, status, map[string]any{
		"type":  "error",
		"error": map[string]string{"type": kind, "message": message},
	})
}

// ── 路由 ────────────────────────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	models, failures := s.opts.Registry.ListModels(context.Background())
	labels := make([]string, 0, len(s.opts.Registry.Sources()))
	for _, item := range s.opts.Registry.Sources() {
		labels = append(labels, item.Label())
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"service":  "claude-code-bridge",
		"upstream": strings.Join(labels, " + "),
		"models":   len(models),
		"model":    s.opts.Model,
		// 单条来源不可用不影响健康（它有可能是没登录的那条）
		"degraded": len(failures) > 0,
	})
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		anthropicError(w, http.StatusUnauthorized, "authentication_error", "missing or invalid API key")
		return
	}
	models, _ := s.opts.Registry.ListModels(r.Context())
	rows := make([]map[string]any, 0, len(models))
	for _, model := range models {
		rows = append(rows, map[string]any{
			"id":           model.ID,
			"type":         "model",
			"display_name": model.Name,
			"created_at":   0,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"data": rows, "has_more": false})
}

func (s *Server) handleCountTokens(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		anthropicError(w, http.StatusUnauthorized, "authentication_error", "missing or invalid API key")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		anthropicError(w, http.StatusBadRequest, "invalid_request_error", "读取请求体失败")
		return
	}
	estimate := 0
	if s.opts.Hooks.EstimateTokens != nil {
		estimate = s.opts.Hooks.EstimateTokens(body)
	}
	writeJSON(w, http.StatusOK, map[string]any{"input_tokens": estimate})
}

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	if r.Method != http.MethodPost {
		anthropicError(w, http.StatusMethodNotAllowed, "invalid_request_error", "只支持 POST")
		return
	}
	if !s.authorized(r) {
		anthropicError(w, http.StatusUnauthorized, "authentication_error", "missing or invalid API key")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		anthropicError(w, http.StatusBadRequest, "invalid_request_error", "读取请求体失败")
		return
	}
	requestedModel := s.opts.Model
	var probe struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	if json.Unmarshal(body, &probe) == nil && probe.Model != "" {
		requestedModel = probe.Model
	}
	requestedModel = config.StripModelSuffix(requestedModel)

	chosen, bare := s.opts.Registry.Resolve(requestedModel)
	if chosen == nil {
		anthropicError(w, http.StatusServiceUnavailable, "api_error", source.ErrNoSources().Error())
		return
	}
	if bare == "" {
		bare = chosen.DefaultModel()
	}
	translated, err := s.opts.Hooks.ToOpenAI(body, TranslateOptions{
		Model:        bare,
		MaxTokensCap: s.opts.MaxTokensCap,
		// 套餐分离的落点：非腾讯来源的 Rewriter 是 nil，system 逐字节不变
		Rewriter: chosen.Rewriter(),
	})
	if err != nil {
		anthropicError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
		return
	}

	meta := s.opts.Registry.Find(requestedModel)
	stream, err := chosen.Chat(r.Context(), source.ChatRequest{Body: translated, Model: bare, Meta: meta})
	if err != nil {
		status, kind, message := classifyUpstream(err)
		s.opts.Log("上游失败 model=%s status=%d %s", requestedModel, status, message)
		anthropicError(w, status, kind, message)
		return
	}
	defer stream.Close()

	options := TranslateOptions{Model: bare, MaxTokensCap: s.opts.MaxTokensCap, Rewriter: chosen.Rewriter(), ShowThinking: s.opts.ShowThinking}
	if probe.Stream {
		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("cache-control", "no-cache")
		w.Header().Set("connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		// 心跳：模型思考几十秒时不能让客户端以为断了
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			ticker := time.NewTicker(time.Duration(s.opts.HeartbeatMs) * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-stop:
					return
				case <-ticker.C:
					fmt.Fprint(w, "event: ping\ndata: {\"type\":\"ping\"}\n\n")
					if flusher != nil {
						flusher.Flush()
					}
				}
			}
		}()
		writer := &flushWriter{w: w, flusher: flusher}
		if err := s.opts.Hooks.Stream(writer, stream, options); err != nil {
			s.opts.Log("流式翻译中断 model=%s err=%v", requestedModel, err)
		}
		s.opts.Log("messages model=%s stream=1 ms=%d", requestedModel, time.Since(started).Milliseconds())
		return
	}

	payload, err := s.opts.Hooks.Message(stream, options)
	if err != nil {
		status, kind, message := classifyUpstream(err)
		anthropicError(w, status, kind, message)
		return
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
	s.opts.Log("messages model=%s stream=0 ms=%d", requestedModel, time.Since(started).Milliseconds())
}

type flushWriter struct {
	w       io.Writer
	flusher http.Flusher
}

func (f *flushWriter) Write(p []byte) (int, error) {
	n, err := f.w.Write(p)
	if f.flusher != nil {
		f.flusher.Flush()
	}
	return n, err
}

// classifyUpstream 把上游错误映射成 Anthropic 能显示的状态码与错误类型。
//
// 分支按 errs 的 **Subtype** 走，不看消息文本 —— 这也是 subtype 存在的意义。
func classifyUpstream(err error) (int, string, string) {
	typed, ok := errs.As(err)
	if !ok {
		return http.StatusBadGateway, "api_error", err.Error()
	}
	switch typed.Subtype {
	case errs.SubtypeContentBlocked, errs.SubtypeShapeRejected:
		// 风控拦截与门禁拒绝都是上游语义的失败，不是本地的 bug
		return http.StatusBadGateway, "api_error", typed.Human()
	case errs.SubtypeQuotaLimited:
		return http.StatusTooManyRequests, "rate_limit_error", typed.Human()
	case errs.SubtypeNotLoggedIn, errs.SubtypeMissingAPIKey, errs.SubtypeRefreshFailed:
		return http.StatusUnauthorized, "authentication_error", typed.Human()
	case errs.SubtypeMissingSession, errs.SubtypeBadStatus:
		return http.StatusBadGateway, "api_error", typed.Human()
	default:
		return http.StatusBadGateway, "api_error", typed.Human()
	}
}
