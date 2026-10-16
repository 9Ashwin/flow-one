// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package service 让反代常驻：macOS 走 launchd，Linux 走 systemd user unit。
//
// 平台差异全部落在 build tag 分出来的文件里：
//
//   - service_darwin.go：launchd plist、`launchctl bootstrap/bootout`、日志文件提示；
//   - service_linux.go：systemd user unit、`systemctl --user daemon-reload/enable --now`、
//     journalctl 提示；
//   - service_unsupported.go：其它平台老实说「不支持」，而不是留一条只有 macOS 能走的路径。
//
// 公共流程（安装、卸载、状态、账本）留在这个不带平台头的文件里；两份**纯文本**的渲染
// 与解析（launchd.go / systemd.go）同样不带平台头 —— 它们不碰系统命令，于是两边的
// 服务文件在任一平台上都能断言。
//
// 本层只读写状态，**不做交互**：问不问「装成开机自启」由 cmd 层的向导决定，
// 答案存在账本里（Choice / RecordChoice），装过就不再问第二遍。
package service

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"

	"github.com/9Ashwin/flow-one/errs"
	"github.com/9Ashwin/flow-one/internal/claude"
	"github.com/9Ashwin/flow-one/internal/config"
)

// ServiceLabel 是服务的名字（launchd 的 label / systemd 的 unit 名），
// 卸载、查询与日志提示都用它。
const ServiceLabel = "dev.flow-one"

// LegacyServiceLabel 是改名（claude-code-openai-bridge → flow-one）之前的服务名。
//
// 改名后如果不管旧服务，会变成「旧服务还在跑、新服务又装一个」——两个进程抢同一个
// 端口（谁赢取决于启动顺序），表现是服务时好时坏，而界面上完全看不出来。
// 所以装新的之前先清旧的；卸载时也把旧的清掉（卸载就该什么都不剩）。
const LegacyServiceLabel = "dev.claude-code-openai-bridge"

// 账本里「后台服务」那一节的键。
const (
	serviceKey        = "service"
	autoStartKey      = "autoStart"
	autoStartAskedKey = "autoStartAsked"
)

// Kind 是常驻机制。
type Kind string

const (
	// KindLaunchd：macOS 的 launchd agent。
	KindLaunchd Kind = "launchd"
	// KindSystemd：Linux 的 systemd user unit。
	KindSystemd Kind = "systemd"
	// KindUnsupported：本平台没有实现（如实报告，不假装成功）。
	KindUnsupported Kind = "unsupported"
)

// State 描述本机常驻服务的现状。
type State struct {
	Kind Kind
	// Path 是服务文件位置。
	Path string
	// Installed 按「服务文件是否存在」判断 —— 它说的是「装过」，不是「正在跑」。
	Installed bool
	// LegacyInstalled 报告改名前的旧服务还在（`dev.claude-code-openai-bridge`）。
	//
	// 单独报出来是因为这个状态最容易被误读：新名字的服务文件不存在，界面上就是
	// 「未安装」，可旧服务其实正在跑、占着端口 —— 用户会以为「没装服务却又能用」，
	// 或者装完新的之后两个进程抢同一个端口。
	LegacyInstalled bool
	// Supported 报告本平台有没有实现。
	Supported bool
}

// Options 是安装常驻服务需要的参数。
type Options struct {
	// Port 写进服务环境的 BRIDGE_PORT。
	Port int
	// APIKey 非空时写进 BRIDGE_API_KEY。
	APIKey string
	// Env 是额外环境变量（BRIDGE_MODE / BRIDGE_MODEL / BRIDGE_PRODUCTS 等）。
	// 这些**必须**写进服务环境：服务是不带参数启动的，少了它们会退回默认配置，
	// 与用户刚选的配置不一致。
	Env map[string]string
	// Command 是服务要执行的完整命令行；空则用当前可执行文件。
	Command []string
	// LogDir 是 launchd 的标准输出目录；空则用 BRIDGE_HOME。
	LogDir string
}

// InstallResult 如实报告这次装了什么、加载结果如何。
type InstallResult struct {
	Kind  Kind
	Path  string
	Notes []string
}

// UninstallResult 如实报告这次卸了什么。
type UninstallResult struct {
	Skipped bool
	Reason  string
	Kind    Kind
	Path    string
}

// Choice 是「要不要装成开机自启的后台服务」这一问的答案。
//
// 交互式配置会反复跑（加一条来源、换个模型都要跑一遍），装过就别再问第二遍
// （AGENTS.md「别重复问同一件事」）。这里只负责把答案存下来。
type Choice struct {
	// AutoStart 是用户上次的选择。
	AutoStart bool
	// Asked 表示这一问已经问过。
	Asked bool
}

// Recorded 是账本里记的「上次装的服务」。
type Recorded struct {
	Kind    Kind              `json:"kind"`
	Path    string            `json:"path"`
	Port    int               `json:"port"`
	Env     map[string]string `json:"env"`
	CLIPath string            `json:"cliPath"`
}

// Inspect 返回本机常驻服务的现状。
func Inspect() (State, error) {
	kind := platformKind()
	file, err := platformServicePath()
	if err != nil {
		return State{Kind: kind}, err
	}
	installed := false
	if file != "" {
		if _, err := os.Stat(file); err == nil {
			installed = true
		}
	}
	legacyInstalled := false
	if legacy, legacyErr := legacyServicePath(); legacyErr == nil && legacy != "" {
		if _, statErr := os.Stat(legacy); statErr == nil {
			legacyInstalled = true
		}
	}
	return State{
		Kind: kind, Path: file, Installed: installed,
		LegacyInstalled: legacyInstalled, Supported: kind != KindUnsupported,
	}, nil
}

// CLIPath 报告服务文件里真正被执行的那份代码在哪；没装或读不出来返回 ""。
//
// 真实踩过：全局安装会把服务指向一份**快照**，之后 `git pull` 或改仓库都不影响它，
// 而界面上完全看不出来（表现是「新功能在命令行有、服务里没有」）。status 与 doctor
// 拿它与 CurrentCLIPath() 对比，就能把这件事显形。
func CLIPath() string {
	kind := platformKind()
	file, err := platformServicePath()
	if err != nil || file == "" {
		return ""
	}
	payload, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	return CLIPathFromServiceFile(string(payload), kind)
}

// CurrentCLIPath 是当前进程正在跑的那份可执行文件。
func CurrentCLIPath() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	return executable
}

// CLIPathFromServiceFile 从服务文件内容里取出被执行的 CLI 路径。纯函数，两种 kind 都认，
// 所以两边的断言都能在任一平台上跑。
//
// 两种形态都要认：`[node, /abs/cli.mjs]`（解释器 + 脚本，Node 版留下的 plist 就是这种）
// 与 `[/abs/flow-one, serve]`（二进制 + 子命令）。判据是「第二个参数是不是
// 绝对路径」。只取第一条会把前者报成 `…/bin/node` —— doctor 会因此误报
// 「服务跑的不是当前这份代码」，而那条检查存在的全部意义就是抓这个。
func CLIPathFromServiceFile(text string, kind Kind) string {
	switch kind {
	case KindLaunchd:
		return launchdCLIPath(parseLaunchdCommand(text))
	case KindSystemd:
		return systemdCLIPath(parseSystemdExecStart(text))
	}
	return ""
}

// launchdCLIPath 从 ProgramArguments 里挑出「真正被执行的那份代码」。
//
// 两种形态都要认，只取第一条或只取最后一条都会错一种：
//
//	[node, /abs/path/cli.mjs]          → /abs/path/cli.mjs（解释器 + 脚本）
//	[/abs/path/flow-one, serve] → /abs/path/flow-one（二进制 + 子命令）
//
// 判据是「第二个参数是不是绝对路径」：`serve` 不是，于是落到第一条。
// 早先只取第一条，doctor 会对着 Node 版留下的 plist 报「服务跑的是 …/bin/node」——
// 假阳性，而这条检查存在的全部意义就是抓「服务指向另一份代码」。
func launchdCLIPath(command []string) string {
	if len(command) == 0 {
		return ""
	}
	if len(command) > 1 && filepath.IsAbs(command[1]) {
		return command[1]
	}
	return command[0]
}

// systemdCLIPath 同理：`ExecStart=/usr/bin/node /opt/bridge/cli.mjs` 要取脚本路径。
// 参数切分复用 parseSystemdExecStart 背后的分词器（它处理了引号与转义）。
func systemdCLIPath(args []string) string {
	if len(args) == 0 {
		return ""
	}
	if len(args) > 1 && filepath.IsAbs(args[1]) {
		return args[1]
	}
	return args[0]
}

// Record 读账本里的「后台服务」那一节。doctor 用它比对服务环境与当前密钥/模型。
func Record() (Recorded, bool) {
	home, err := config.Home()
	if err != nil {
		return Recorded{}, false
	}
	raw, found := claude.ReadInstallState(home)[serviceKey]
	if !found {
		return Recorded{}, false
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return Recorded{}, false
	}
	var record Recorded
	if err := json.Unmarshal(encoded, &record); err != nil {
		return Recorded{}, false
	}
	return record, true
}

// LastChoice 读上次对「装成开机自启」的选择；账本里没记录时 ok=false。
func LastChoice() (Choice, bool) {
	home, err := config.Home()
	if err != nil {
		return Choice{}, false
	}
	state := claude.ReadInstallState(home)
	asked, _ := state[autoStartAskedKey].(bool)
	if !asked {
		return Choice{}, false
	}
	autoStart, _ := state[autoStartKey].(bool)
	return Choice{AutoStart: autoStart, Asked: true}, true
}

// RecordChoice 记下这次的选择（向导问完就调它，下次配置据此不再问）。
func RecordChoice(autoStart bool) error {
	home, err := config.Home()
	if err != nil {
		return err
	}
	state := claude.ReadInstallState(home)
	state[autoStartKey] = autoStart
	state[autoStartAskedKey] = true
	return claude.WriteInstallState(home, state)
}

// Install 装成开机自启的常驻服务。
func Install(opts Options) (InstallResult, error) {
	kind := platformKind()
	if kind == KindUnsupported {
		return InstallResult{Kind: kind}, errs.Config(errs.SubtypeServiceUnsupported,
			fmt.Sprintf("暂不支持 %s 的常驻服务", runtime.GOOS)).
			WithHint("本工具只为 macOS 的 launchd 与 Linux 的 systemd user unit 生成服务文件；其它平台请把命令放进自己的启动项")
	}
	home, err := config.Home()
	if err != nil {
		return InstallResult{Kind: kind}, err
	}
	if opts.LogDir == "" {
		opts.LogDir = home
	}
	if err := os.MkdirAll(opts.LogDir, 0o700); err != nil {
		return InstallResult{Kind: kind}, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "建不了日志目录 "+opts.LogDir)
	}
	file, err := platformServicePath()
	if err != nil {
		return InstallResult{Kind: kind}, err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return InstallResult{Kind: kind}, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "建不了服务目录 "+filepath.Dir(file))
	}
	// 装新的之前先清改名前的旧服务：两个都活着就会抢同一个端口
	legacyNotes, err := removeLegacyService()
	if err != nil {
		return InstallResult{Kind: kind, Path: file}, err
	}
	text, err := renderServiceFile(opts)
	if err != nil {
		return InstallResult{Kind: kind}, err
	}
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		return InstallResult{Kind: kind}, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "写不了服务文件 "+file)
	}
	command, err := commandOf(opts)
	if err != nil {
		return InstallResult{Kind: kind, Path: file}, err
	}
	state := claude.ReadInstallState(home)
	// 账本里记**生效的**服务环境（含 BRIDGE_PORT 与 BRIDGE_API_KEY）：doctor 拿它跟
	// settings.json 的 ANTHROPIC_AUTH_TOKEN / BASE_URL 端口对比，少了这两项那两条
	// 「密钥不一致」「端口不一致」的检查就永远不触发。
	state[serviceKey] = Recorded{Kind: kind, Path: file, Port: opts.Port, Env: effectiveEnv(opts), CLIPath: command[0]}
	if err := claude.WriteInstallState(home, state); err != nil {
		return InstallResult{Kind: kind, Path: file}, err
	}
	notes, err := loadService(file)
	if err != nil {
		return InstallResult{Kind: kind, Path: file}, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeUnexpected,
			fmt.Sprintf("服务文件已写入 %s，但加载失败：%v", file, err)).
			WithHint(manualHint(command, opts))
	}
	return InstallResult{Kind: kind, Path: file, Notes: append(legacyNotes, notes...)}, nil
}

// removeLegacyService 清掉改名前的旧服务：先让它从 launchd / systemd 里退出来，
// 再删服务文件。返回给用户看的说明（没清到东西就返回 nil）。
//
// 卸载失败也照样删文件：留下一个还在跑、却已经没有服务文件的进程，比留下一个能被
// 下次卸载清掉的文件更糟。
func removeLegacyService() ([]string, error) {
	file, err := legacyServicePath()
	if err != nil || file == "" {
		return nil, err
	}
	if _, statErr := os.Stat(file); statErr != nil {
		return nil, nil // 没有旧服务：什么都不做，也不打扰用户
	}
	_ = unloadLegacyService(file)
	if err := os.Remove(file); err != nil {
		return nil, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "删不掉改名前的旧服务文件 "+file)
	}
	return []string{"已清理改名前的旧服务 " + LegacyServiceLabel + "（避免新旧两个服务抢同一个端口）"}, nil
}

// Uninstall 卸掉常驻服务并清掉账本里那一节。
func Uninstall() (UninstallResult, error) {
	kind := platformKind()
	if kind == KindUnsupported {
		return UninstallResult{Skipped: true, Reason: "本平台不支持常驻服务"}, nil
	}
	file, err := platformServicePath()
	if err != nil {
		return UninstallResult{}, err
	}
	if file == "" {
		return UninstallResult{Skipped: true, Reason: "本平台不支持常驻服务"}, nil
	}
	if _, err := os.Stat(file); err != nil {
		if os.IsNotExist(err) {
			return UninstallResult{Skipped: true, Reason: "没有装过后台服务"}, nil
		}
		return UninstallResult{}, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "读不到 "+file)
	}
	// 没在跑就算了，文件还是要删掉
	_ = unloadService(file)
	if err := os.Remove(file); err != nil {
		return UninstallResult{}, errs.Wrap(err, errs.CategoryInternal, errs.SubtypeIOFailed, "删不掉 "+file)
	}
	// 改名前的旧服务也要一并带走：卸载就该什么都不剩
	if _, err := removeLegacyService(); err != nil {
		return UninstallResult{}, err
	}
	home, err := config.Home()
	if err != nil {
		return UninstallResult{}, err
	}
	state := claude.ReadInstallState(home)
	delete(state, serviceKey)
	// 「装成开机自启」那一问也跟着忘掉：用户既然卸载了，下次配置就该重新问一遍
	delete(state, autoStartKey)
	delete(state, autoStartAskedKey)
	if err := claude.WriteInstallState(home, state); err != nil {
		return UninstallResult{}, err
	}
	return UninstallResult{Kind: kind, Path: file}, nil
}

// commandOf 解析服务要执行的命令行；没给就用当前可执行文件。
func commandOf(opts Options) ([]string, error) {
	command := slices.Clone(opts.Command)
	if len(command) > 0 && command[0] != "" {
		return command, nil
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, errs.InternalFrom(err).WithHint("显式指定服务要执行的命令")
	}
	return []string{executable}, nil
}

// envPair 是服务进程的一个环境变量；顺序固定，服务文件的文本才可断言。
type envPair struct {
	Key   string
	Value string
}

// serviceEnv 汇总服务进程的环境：端口、密钥、以及调用方给的额外项。
//
// BRIDGE_PORT 永远排第一（与 Node 版的文本一致），其余按 key 排序；额外项最后合并，
// 所以它能覆盖端口这类默认值（但不会写重复的键 —— plist 与 unit 都不接受重复键）。
func serviceEnv(opts Options) []envPair {
	values := map[string]string{"BRIDGE_PORT": strconv.Itoa(opts.Port)}
	if opts.APIKey != "" {
		values["BRIDGE_API_KEY"] = opts.APIKey
	}
	for key, value := range opts.Env {
		if key == "" {
			continue
		}
		values[key] = value
	}
	keys := slices.Sorted(maps.Keys(values))
	pairs := make([]envPair, 0, len(values))
	pairs = append(pairs, envPair{Key: "BRIDGE_PORT", Value: values["BRIDGE_PORT"]})
	for _, key := range keys {
		if key == "BRIDGE_PORT" {
			continue
		}
		pairs = append(pairs, envPair{Key: key, Value: values[key]})
	}
	return pairs
}

// effectiveEnv 把生效的服务环境摊成 map，供账本记录。
func effectiveEnv(opts Options) map[string]string {
	pairs := serviceEnv(opts)
	values := make(map[string]string, len(pairs))
	for _, pair := range pairs {
		values[pair.Key] = pair.Value
	}
	return values
}

// logDirOf 是服务日志目录：调用方给的优先，否则 BRIDGE_HOME。
func logDirOf(opts Options) (string, error) {
	if opts.LogDir != "" {
		return opts.LogDir, nil
	}
	return config.Home()
}

// manualHint 是加载失败时的补救提示：照着服务文件里的环境把服务手动跑起来。
// 密钥用占位符，别把令牌打进终端滚屏或 CI 日志。
func manualHint(command []string, opts Options) string {
	parts := make([]string, 0, len(opts.Env)+len(command)+2)
	for _, pair := range serviceEnv(opts) {
		value := pair.Value
		if pair.Key == "BRIDGE_API_KEY" {
			value = "<服务文件里那个>"
		}
		parts = append(parts, pair.Key+"="+value)
	}
	parts = append(parts, command...)
	return "先手动跑起来：" + strings.Join(parts, " ")
}
