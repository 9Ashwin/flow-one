// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package opencode

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/source"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 门禁只验形状：`ses_` + 12 位小写 hex + 14 位 base62（尾段总长 26，写成 38 一律 403）。
var (
	sessionPattern = regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	requestPattern = regexp.MustCompile(`^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	projectPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// 免费档必须凑齐的 5 个 x-opencode-* 头（外加 opencode/<版本> 的 UA）。
var gateHeaderNames = []string{
	"X-Opencode-Project",
	"X-Opencode-Session",
	"X-Opencode-Session-Id",
	"X-Opencode-Request",
	"X-Opencode-Client",
}

func TestSessionAndRequestIDShapes(t *testing.T) {
	scratch(t)
	// 尾段总长 26 = 12 hex + 14 base62；误做成「随机 26 位」会得到 38 字符而被 403
	for range 50 {
		session := NewSessionID()
		assert.Regexp(t, sessionPattern, session)
		assert.Len(t, session, 4+26)

		request := NewRequestID()
		assert.Regexp(t, requestPattern, request)
		assert.Len(t, request, 4+26)
	}
	// 同一毫秒内也不能重复（sequence 递增）
	first, second := NewSessionID(), NewSessionID()
	assert.NotEqual(t, first[:16], second[:16])
}

func TestProjectIDPersistsAcrossCalls(t *testing.T) {
	home := scratch(t)
	first := projectID(home)
	assert.Regexp(t, projectPattern, first)
	assert.Equal(t, first, projectID(home), "项目 id 必须落盘复用，每次换一个会被看成新客户端")

	// 形状不对的落盘值要重新生成（用户手改过）
	require.NoError(t, writeFile(t, home+"/opencode.json", `{"projectId":"nope"}`))
	regenerated := projectID(home)
	assert.Regexp(t, projectPattern, regenerated)
	assert.NotEqual(t, "nope", regenerated)

	// 导出的那一个走 BRIDGE_HOME，doctor 直接用它拼形状
	assert.Equal(t, regenerated, ProjectID())
}

func TestFreeTierOutboundShape(t *testing.T) {
	home := scratch(t)
	resetCapabilities(t)
	rec := newRecorder(t, nil)
	free, err := NewFreeTier(testOptions(rec, rec.server.URL+"/api.json"))
	require.NoError(t, err)

	stream, err := free.Chat(context.Background(), source.ChatRequest{Body: freeBody(), Model: "deepseek-v4.1-flash-free"})
	require.NoError(t, err)
	drain(t, stream)

	require.Equal(t, 1, rec.count())
	got := rec.taken()[0]
	assert.Equal(t, http.MethodPost, got.method)
	assert.Equal(t, "/v1/chat/completions", got.path)
	assert.Equal(t, "Bearer public", got.header.Get("Authorization"), "免费档匿名凭据是字面量 public")
	assert.Equal(t, "text/event-stream", got.header.Get("Accept"))

	// 5 个 x-opencode-* 头一个都不能少
	for _, name := range gateHeaderNames {
		assert.NotEmptyf(t, got.header.Get(name), "缺了门禁头 %s", name)
	}
	assert.Equal(t, "cli", got.header.Get("X-Opencode-Client"))
	assert.Regexp(t, `^opencode/`, got.header.Get("User-Agent"))
	assert.Regexp(t, projectPattern, got.header.Get("X-Opencode-Project"))
	session := got.header.Get("X-Opencode-Session")
	assert.Regexp(t, sessionPattern, session)
	assert.Equal(t, session, got.header.Get("X-Opencode-Session-Id"), "别名头必须与 session 同值")
	assert.Regexp(t, requestPattern, got.header.Get("X-Opencode-Request"))

	// 报文形状：stream 强制 true，四个小写门禁工具齐全，调用方的原名出站改小写
	assert.Equal(t, true, got.body["stream"])
	assert.Equal(t, "deepseek-v4.1-flash-free", got.body["model"])
	names := toolNames(t, got.body)
	for _, gate := range []string{"bash", "glob", "grep", "read"} {
		assert.Truef(t, contains(names, gate), "缺了门禁工具 %s（报文形状会被门禁拒）", gate)
	}
	assert.Equal(t, 1, countOf(names, "bash"), "调用方声明过的不该再补桩")
	assert.True(t, contains(names, "Edit"), "非门禁工具原样保留")
	assert.NotContains(t, names, "Bash")

	// 项目 id 落在 BRIDGE_HOME 下，不是随机每次换
	assert.FileExists(t, home+"/opencode.json")
}

func TestFreeTierSessionIsStableAcrossTurns(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	rec := newRecorder(t, nil)
	free, err := NewFreeTier(testOptions(rec, rec.server.URL+"/api.json"))
	require.NoError(t, err)

	for range 2 {
		stream, err := free.Chat(context.Background(), source.ChatRequest{Body: freeBody(), Model: "deepseek-v4.1-flash-free"})
		require.NoError(t, err)
		drain(t, stream)
	}
	requests := rec.taken()
	require.Len(t, requests, 2)
	assert.Equal(t, requests[0].header.Get("X-Opencode-Session"), requests[1].header.Get("X-Opencode-Session"),
		"进程级会话 id 必须复用：每次换一个会被当成很多独立会话")
	assert.NotEqual(t, requests[0].header.Get("X-Opencode-Request"), requests[1].header.Get("X-Opencode-Request"),
		"request id 是每请求一个")
}

func TestFreeTierRestoresToolCallsAndDropsStubs(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	frames := []string{
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"bash","arguments":"{\"command\":"}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"glob","arguments":"{\"pattern\":\"*\"}"}}]}}]}`,
		`{"choices":[{"delta":{"content":"完成"}}]}`,
	}
	rec := newRecorder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte(sseBody(frames...)))
		return true
	})
	free, err := NewFreeTier(testOptions(rec, rec.server.URL+"/api.json"))
	require.NoError(t, err)

	stream, err := free.Chat(context.Background(), source.ChatRequest{Body: freeBody(), Model: "deepseek-v4.1-flash-free"})
	require.NoError(t, err)
	out := drain(t, stream)
	require.Len(t, out, 4)

	// bash 改回调用方的原名；参数分片原样跟着走
	var first map[string]any
	require.NoError(t, json.Unmarshal([]byte(out[0]), &first))
	assert.Equal(t, "Bash", firstToolName(t, first))
	assert.JSONEq(t, frames[1], out[1], "没动过的帧必须逐字节原样透传")

	// 桩工具的调用整条丢弃：这里让 tool_calls 变成空数组，而不是留一条没有名字的调用
	var third map[string]any
	require.NoError(t, json.Unmarshal([]byte(out[2]), &third))
	calls := firstChoiceDelta(t, third)["tool_calls"]
	assert.Equal(t, []any{}, calls)
	assert.NotContains(t, out[2], "glob", "桩工具的调用不能转发给调用方")
	assert.Equal(t, frames[3], out[3], "与门禁无关的帧原样透传")
}

func TestFreeTierGateRejectionIsTyped(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	rec := newRecorder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		upstreamError(w, http.StatusForbidden, "FreeTierError", "OpenCode's free tier can only be used from within OpenCode.")
		return true
	})
	free, err := NewFreeTier(testOptions(rec, rec.server.URL+"/api.json"))
	require.NoError(t, err)

	_, err = free.Chat(context.Background(), source.ChatRequest{Body: freeBody(), Model: "x"})
	require.Error(t, err)
	typed, isTyped := errs.As(err)
	require.True(t, isTyped)
	assert.Equal(t, errs.CategoryUpstream, typed.Category)
	assert.Equal(t, errs.SubtypeShapeRejected, typed.Subtype)
	assert.Equal(t, http.StatusForbidden, typed.Code)
	assert.Contains(t, typed.Message, "free tier can only be used")
}

func TestFreeTierListModelsMergesCapabilitiesAndCaches(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	devHits := 0
	rec := newRecorder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"data":[
				{"id":"deepseek-v4.1-flash-free","object":"model","created":1,"owned_by":"opencode"},
				{"id":"deepseek-v4.1-flash","object":"model","created":2,"owned_by":"opencode"}
			]}`))
		case "/api.json":
			devHits++
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"opencode":{"models":{
				"deepseek-v4.1-flash-free":{"name":"DeepSeek V4.1 Flash Free","limit":{"context":200000,"output":8192},"attachment":true}
			}}}`))
		default:
			upstreamError(w, http.StatusNotFound, "not_found", "no such path")
		}
		return true
	})
	free, err := NewFreeTier(testOptions(rec, rec.server.URL+"/api.json"))
	require.NoError(t, err)

	models, err := free.ListModels(context.Background())
	require.NoError(t, err)
	require.Len(t, models, 2)
	assert.Equal(t, "deepseek-v4.1-flash-free", models[0].ID)
	assert.Equal(t, "DeepSeek V4.1 Flash Free", models[0].Name)
	assert.Equal(t, 200000, models[0].ContextWindow, "免费档实测是 200k，不是 1M")
	assert.Equal(t, 8192, models[0].MaxOutputTokens)
	assert.True(t, models[0].SupportsImages)
	assert.True(t, models[0].Free, "`-free` 结尾的是免费档")
	assert.False(t, models[1].Free)
	assert.Equal(t, "deepseek-v4.1-flash", models[1].Name, "能力表里没有就退回裸 ID")

	// 清单请求本身也要是匿名形状
	listing := rec.taken()[0]
	assert.Equal(t, http.MethodGet, listing.method)
	assert.Equal(t, "/v1/models", listing.path)
	assert.Equal(t, "Bearer public", listing.header.Get("Authorization"))

	// 1 小时缓存：第二次列清单不该再打 models.dev
	models, err = free.ListModels(context.Background())
	require.NoError(t, err)
	require.Len(t, models, 2)
	assert.Equal(t, 1, devHits, "能力表在 TTL 内只取一次")
}

func TestFreeTierListModelsSurvivesCapabilityFailure(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	rec := newRecorder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		if r.URL.Path == "/v1/models" {
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"id":"deepseek-v4.1-flash-free","object":"model"}]}`))
			return true
		}
		upstreamError(w, http.StatusInternalServerError, "server_error", "models.dev 挂了")
		return true
	})
	free, err := NewFreeTier(testOptions(rec, rec.server.URL+"/api.json"))
	require.NoError(t, err)

	models, err := free.ListModels(context.Background())
	require.NoError(t, err, "能力表挂了不该让模型清单也用不了")
	require.Len(t, models, 1)
	assert.Equal(t, 0, models[0].ContextWindow, "拿不到元数据就退回「未知」")
	assert.False(t, models[0].SupportsImages)
}

func TestFreeTierMetadataFailureIsNotCached(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	devHits := 0
	devBroken := true
	rec := newRecorder(t, func(w http.ResponseWriter, r *http.Request, body map[string]any) bool {
		switch r.URL.Path {
		case "/v1/models":
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"data":[{"id":"deepseek-v4.1-flash-free","object":"model"}]}`))
		case "/api.json":
			devHits++
			if devBroken {
				upstreamError(w, http.StatusBadGateway, "server_error", "暂时挂了")
				return true
			}
			w.Header().Set("content-type", "application/json")
			_, _ = w.Write([]byte(`{"opencode":{"models":{"deepseek-v4.1-flash-free":{"limit":{"context":200000}}}}}`))
		}
		return true
	})
	free, err := NewFreeTier(testOptions(rec, rec.server.URL+"/api.json"))
	require.NoError(t, err)

	_, err = free.ListModels(context.Background())
	require.NoError(t, err)
	devBroken = false
	models, err := free.ListModels(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 2, devHits, "失败的那次不算缓存，下次要重试")
	assert.Equal(t, 200000, models[0].ContextWindow)
}

func TestNonTencentSourcesNeverRewrite(t *testing.T) {
	scratch(t)
	resetCapabilities(t)
	rec := newRecorder(t, nil)
	free, err := NewFreeTier(testOptions(rec, rec.server.URL+"/api.json"))
	require.NoError(t, err)
	goTier, err := NewGoTier(Options{BaseURL: rec.server.URL, HTTPClient: rec.server.Client()})
	require.NoError(t, err)

	// 硬不变式：非 WorkBuddy 来源绝不走腾讯内容风控改写
	assert.Nil(t, free.Rewriter())
	assert.Nil(t, goTier.Rewriter())
}

func TestFreeTierMetadata(t *testing.T) {
	free, err := NewFreeTier(Options{Home: t.TempDir()})
	require.NoError(t, err)
	assert.Equal(t, "oc", free.ID())
	assert.Equal(t, "OpenCode 免费模型", free.Label())
	assert.Equal(t, source.AuthNone, free.Auth())
	assert.Equal(t, "deepseek-v4.1-flash-free", free.DefaultModel())
}

// firstToolName 取出第一个 choice.delta.tool_calls[0].function.name。
func firstToolName(t *testing.T, chunk map[string]any) string {
	t.Helper()
	calls, isList := firstChoiceDelta(t, chunk)["tool_calls"].([]any)
	require.True(t, isList)
	require.NotEmpty(t, calls)
	call, isCall := calls[0].(map[string]any)
	require.True(t, isCall)
	function, isFunction := call["function"].(map[string]any)
	require.True(t, isFunction)
	name, _ := function["name"].(string)
	return name
}

func firstChoiceDelta(t *testing.T, chunk map[string]any) map[string]any {
	t.Helper()
	choices, isList := chunk["choices"].([]any)
	require.True(t, isList)
	require.NotEmpty(t, choices)
	choice, isChoice := choices[0].(map[string]any)
	require.True(t, isChoice)
	delta, isDelta := choice["delta"].(map[string]any)
	require.True(t, isDelta)
	return delta
}

func countOf(values []string, want string) int {
	count := 0
	for _, value := range values {
		if value == want {
			count++
		}
	}
	return count
}

func TestShapeHeadersIsExactlyTheFullGateShape(t *testing.T) {
	// doctor 拿它当「完整形状」的基准，再逐项删掉一个要件做变体：所以这里必须是
	// 一个不多一个不少的那 5 个头，别名头与 session 同值。
	header := ShapeHeaders("project-1", "ses_0123456789ab0123456789ABCD", "msg_0123456789ab0123456789ABCD")
	names := []string{}
	for name := range header {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-opencode-") {
			names = append(names, lower)
		}
	}
	slices.Sort(names)
	assert.Equal(t, []string{
		"x-opencode-client",
		"x-opencode-project",
		"x-opencode-request",
		"x-opencode-session",
		"x-opencode-session-id",
	}, names, "门禁形状就是这 5 个头")
	assert.Equal(t, "cli", header.Get("X-Opencode-Client"))
	assert.Equal(t, header.Get("X-Opencode-Session"), header.Get("X-Opencode-Session-Id"))
	assert.Regexp(t, `^opencode/`, header.Get("User-Agent"))
}
