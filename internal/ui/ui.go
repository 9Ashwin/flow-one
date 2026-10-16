// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

// Package ui 是终端界面：颜色、宽度对齐、编号菜单、可筛选的选择器、转圈与密钥输入。
//
// 两条设计约束：
//
//   - **无 TTY 时必须能降级**：管道 / systemd 场景下不进交互，直接返回明确错误，
//     而不是把进程挂死在等按键上；
//   - **测试缝**：`SetInputForTest` 换一根输入管子，用例不需要改全局 stdin
//     （Node 版踩过：篡改 process.stdin 会把测试运行器的记账搅乱）。
package ui

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"
)

// ── 颜色 ────────────────────────────────────────────────────────────────────

const reset = "\x1b[0m"

func wrap(code string) func(string) string {
	return func(text string) string { return code + text + reset }
}

var (
	Bold   = wrap("\x1b[1m")
	Dim    = wrap("\x1b[2m")
	Cyan   = wrap("\x1b[36m")
	Green  = wrap("\x1b[32m")
	Yellow = wrap("\x1b[33m")
	Red    = wrap("\x1b[31m")
	Gray   = wrap("\x1b[90m")
)

var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;]*[A-Za-z]`)

// DisplayWidth 是终端里占的列数：颜色码零宽，CJK 占两列。
//
// 边框对齐全靠它 —— Node 版最早就是没剥颜色码，摘要框右边多出一截。
func DisplayWidth(text string) int {
	width := 0
	for _, r := range ansiPattern.ReplaceAllString(text, "") {
		if isWide(r) {
			width += 2
		} else {
			width++
		}
	}
	return width
}

func isWide(r rune) bool {
	switch {
	case r >= 0x1100 && r <= 0x115F,
		r >= 0x2E80 && r <= 0xA4CF,
		r >= 0xAC00 && r <= 0xD7A3,
		r >= 0xF900 && r <= 0xFAFF,
		r >= 0xFE30 && r <= 0xFE6F,
		r >= 0xFF00 && r <= 0xFF60,
		r >= 0xFFE0 && r <= 0xFFE6:
		return true
	}
	return false
}

func padTo(text string, width int) string {
	gap := width - DisplayWidth(text)
	if gap <= 0 {
		return text
	}
	return text + strings.Repeat(" ", gap)
}

// ── 输出块 ──────────────────────────────────────────────────────────────────

// Out 是普通输出（stdout）。测试可以换掉它。
var Out io.Writer = os.Stdout

// ErrOut 是错误与提示（stderr）—— 按 AGENTS.md 的契约，成功数据才进 stdout。
var ErrOut io.Writer = os.Stderr

func Note(text string)    { fmt.Fprintln(Out, text) }
func Blank()              { fmt.Fprintln(Out) }
func Success(text string) { fmt.Fprintln(Out, Green("✔")+" "+text) }
func Warn(text string)    { fmt.Fprintln(ErrOut, Yellow("!")+" "+text) }
func Fail(text string)    { fmt.Fprintln(ErrOut, Red("✖")+" "+text) }
func Info(text string)    { fmt.Fprintln(Out, Cyan("›")+" "+text) }

// Section 是步骤小标题（`──────── 第 2 步 · 登录 ────────`）。
func Section(title string) {
	Blank()
	Note("  " + Dim("──────── "+title+" ────────"))
}

// Heading 是一节的大标题。
func Heading(title string) {
	Blank()
	Note(Bold(title))
}

// Box 画一个内部宽度对齐的框。
func Box(lines []string, color func(string) string) {
	width := 0
	for _, line := range lines {
		if w := DisplayWidth(line); w > width {
			width = w
		}
	}
	width += 2
	Note(color("  ╭" + strings.Repeat("─", width) + "╮"))
	for _, line := range lines {
		Note(color("  │") + " " + padTo(line, width-1) + color("│"))
	}
	Note(color("  ╰" + strings.Repeat("─", width) + "╯"))
}

// Banner 是开机块：名字 + 版本 + 一句话。
func Banner(subtitle, version string) {
	Blank()
	title := "flow-one"
	if version != "" {
		title += "  " + version
	}
	Box([]string{title, subtitle}, Cyan)
}

// ── 输入缝 ──────────────────────────────────────────────────────────────────

var (
	inputMu      sync.Mutex
	inputReader  io.Reader = os.Stdin
	interactiveO *bool     // 非 nil 时强制「是不是终端」，测试用
)

// SetInputForTest 换掉输入来源，并强制「是不是终端」的判断（仅测试用）。
//
// 为什么连 TTY 判断一起换：用例里 stdout 不是终端，只换 stdin 会让
// IsInteractive() 仍然返回 false，测试根本走不到交互路径。
func SetInputForTest(reader io.Reader, isTTY bool) (restore func()) {
	inputMu.Lock()
	previousReader, previousOverride := inputReader, interactiveO
	inputReader = reader
	flag := isTTY
	interactiveO = &flag
	inputMu.Unlock()
	return func() {
		inputMu.Lock()
		inputReader, interactiveO = previousReader, previousOverride
		inputMu.Unlock()
	}
}

// IsInteractive 报告能否进交互（stdin 与 stdout 都得是终端）。
func IsInteractive() bool {
	inputMu.Lock()
	override := interactiveO
	inputMu.Unlock()
	if override != nil {
		return *override
	}
	return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}

func currentInput() io.Reader {
	inputMu.Lock()
	defer inputMu.Unlock()
	return inputReader
}

// Input 读一行文本。无 TTY 时返回明确错误，而不是挂死。
func Input(message, initial string) (string, error) {
	if !IsInteractive() {
		return "", fmt.Errorf("需要终端交互，但当前没有 TTY")
	}
	suffix := ""
	if initial != "" {
		suffix = Dim(" [" + initial + "]")
	}
	fmt.Fprint(Out, Cyan("?")+" "+message+" "+Dim("回车确认")+suffix+"\n"+Cyan("› ")+" ")
	reader := bufio.NewReader(currentInput())
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	value := strings.TrimRight(line, "\r\n")
	if value == "" {
		return initial, nil
	}
	return value, nil
}

// Confirm 是/否确认，直接回车取 initial。
func Confirm(message string, initial bool) (bool, error) {
	if !IsInteractive() {
		return initial, nil
	}
	hint := "Y/n"
	if !initial {
		hint = "y/N"
	}
	fmt.Fprint(Out, Cyan("?")+" "+message+" "+Dim("("+hint+")")+" ")
	reader := bufio.NewReader(currentInput())
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return initial, err
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true, nil
	case "n", "no":
		return false, nil
	default:
		return initial, nil
	}
}

// Password 读一个不回显的密钥（终端下用 x/term 关掉回显）。
func Password(message string) (string, error) {
	if !IsInteractive() {
		return "", fmt.Errorf("需要终端交互来输入密钥，但当前没有 TTY")
	}
	fmt.Fprint(Out, Cyan("?")+" "+message+" "+Dim("粘贴后回车")+"\n"+Cyan("› ")+" ")
	fd := int(os.Stdin.Fd())
	value, err := term.ReadPassword(fd)
	fmt.Fprintln(Out)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(value)), nil
}

// ── 选择器 ──────────────────────────────────────────────────────────────────

// Option 是一个选项。
type Option struct {
	Label string
	Hint  string
	Value string
	// Separator 只作分组标题：不编号、不可选、光标跳过。
	Separator bool
	Disabled  bool
}

// Spinner 是转圈提示：长操作期间给个「还在动」的信号。
type Spinner struct {
	stop chan struct{}
	done chan struct{}
}

// StartSpinner 启动转圈；调用方负责 Stop。
func StartSpinner(label string) *Spinner {
	spin := &Spinner{stop: make(chan struct{}), done: make(chan struct{})}
	if !IsInteractive() {
		close(spin.done)
		return spin
	}
	go func() {
		defer close(spin.done)
		frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
		ticker := time.NewTicker(90 * time.Millisecond)
		defer ticker.Stop()
		index := 0
		for {
			select {
			case <-spin.stop:
				fmt.Fprint(Out, "\r\x1b[2K")
				return
			case <-ticker.C:
				fmt.Fprintf(Out, "\r\x1b[2K%s %s", Cyan(frames[index%len(frames)]), label)
				index++
			}
		}
	}()
	return spin
}

// Stop 结束转圈并清掉那一行。
func (s *Spinner) Stop() {
	if s == nil {
		return
	}
	select {
	case <-s.stop:
	default:
		close(s.stop)
	}
	<-s.done
}

// ── 测试用 ──────────────────────────────────────────────────────────────────

// ReadLineForTest 只给测试用：直接读一行，不打印提示。
func ReadLineForTest() (string, error) {
	reader := bufio.NewReader(currentInput())
	line, err := reader.ReadString('\n')
	return strings.TrimRight(line, "\r\n"), err
}
