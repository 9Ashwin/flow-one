// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package ui

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"golang.org/x/term"
)

// SelectOptions 调 Select 的可选参数。
type SelectOptions struct {
	// Filterable 打开「边打边筛」：可打印字符进查询串。
	Filterable bool
	// Window 是可见行数上限（只画光标附近那一段），0 表示全部画出。
	Window int
}

// Select 是列表选择。
//
// 交互约定（对齐 Node 版，用户已经习惯）：
//   - 直接敲字筛选（Filterable 时），退格删一个字，Esc 清空查询串；
//   - ↑↓ 在结果里移动，回车确认；
//   - 分组标题（Option.Separator）不编号、不可选、光标跳过，一敲字就隐藏。
func Select(message string, options []Option, opts SelectOptions) (string, error) {
	if len(options) == 0 {
		return "", fmt.Errorf("Select 需要至少一个选项")
	}
	if !IsInteractive() {
		return "", fmt.Errorf("需要终端交互来选择，但当前没有 TTY")
	}
	// 只有真终端才切 raw 模式；测试注入的 reader 直接按字节读
	if currentInput() == os.Stdin {
		if oldState, err := term.MakeRaw(int(os.Stdin.Fd())); err == nil {
			defer term.Restore(int(os.Stdin.Fd()), oldState)
		}
	}
	reader := bufio.NewReader(currentInput())

	query := ""
	visible := options
	cursor := firstSelectable(visible, 0)
	drawn := 0
	hint := "↑↓ 选择，或直接按编号，回车确认"
	if opts.Filterable {
		hint = "直接敲字筛选，↑↓ 选择，回车确认"
	}
	draw := func() {
		lines := renderSelect(message, hint, query, options, visible, cursor, opts)
		clearDrawn(drawn)
		fmt.Fprint(Out, frame(lines))
		drawn = len(lines)
	}
	draw()

	for {
		key, err := readKey(reader)
		if err != nil {
			clearDrawn(drawn)
			if err == io.EOF {
				return "", fmt.Errorf("输入结束，没有做出选择")
			}
			return "", err
		}
		switch {
		case key.name == "up":
			cursor = stepSelectable(visible, cursor, -1)
		case key.name == "down":
			cursor = stepSelectable(visible, cursor, 1)
		case key.name == "backspace" && opts.Filterable:
			if query != "" {
				query = query[:len(query)-1]
				visible, cursor = applyQuery(options, query)
			}
		case key.name == "escape" && opts.Filterable:
			query = ""
			visible, cursor = applyQuery(options, query)
		case key.name == "enter":
			if cursor < len(visible) && !visible[cursor].Disabled && !visible[cursor].Separator {
				chosen := visible[cursor]
				clearDrawn(drawn)
				fmt.Fprint(Out, frame([]string{Green("✔") + " " + message + " " + Bold(chosen.Label)}))
				return chosen.Value, nil
			}
		case opts.Filterable && key.text != "":
			query += key.text
			visible, cursor = applyQuery(options, query)
		case !opts.Filterable && key.text != "":
			// 非筛选模式保留编号直选（短清单不必先筛选）
			visible, cursor = applyQuery(options, query)
		}
		draw()
	}
}

func applyQuery(options []Option, query string) ([]Option, int) {
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return options, firstSelectable(options, 0)
	}
	var matched []Option
	for _, option := range options {
		if option.Separator {
			continue
		}
		if strings.Contains(strings.ToLower(option.Label+" "+option.Value+" "+option.Hint), needle) {
			matched = append(matched, option)
		}
	}
	return matched, firstSelectable(matched, 0)
}

func firstSelectable(list []Option, from int) int {
	if len(list) == 0 {
		return 0
	}
	index := clamp(from, 0, len(list)-1)
	for i := 0; i < len(list); i++ {
		if !list[index].Separator && !list[index].Disabled {
			return index
		}
		index = (index + 1) % len(list)
	}
	return index
}

func stepSelectable(list []Option, cursor, delta int) int {
	if len(list) == 0 {
		return 0
	}
	index := cursor
	for i := 0; i < len(list); i++ {
		index = (index + delta + len(list)) % len(list)
		if !list[index].Separator {
			return index
		}
	}
	return cursor
}

func clamp(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func renderSelect(message, hint, query string, options, visible []Option, cursor int, opts SelectOptions) []string {
	lines := []string{Cyan("?") + " " + message + "  " + Dim(hint)}
	if opts.Filterable {
		if query == "" {
			lines = append(lines, "  "+Dim(fmt.Sprintf("直接敲字筛选 · 共 %d 项", countSelectable(options))))
		} else {
			lines = append(lines, "  "+Cyan("筛选")+" "+Bold(query)+"  "+
				Dim(fmt.Sprintf("%d/%d 项", countSelectable(visible), countSelectable(options))))
		}
	}
	if len(visible) == 0 {
		return append(lines, "  "+Yellow("没有匹配项")+"  "+Dim("退格删字，Esc 清空"))
	}
	size := len(visible)
	if opts.Window > 0 && size > opts.Window {
		size = opts.Window
	}
	start := clamp(cursor-size/2, 0, len(visible)-size)
	digits := len(fmt.Sprintf("%d", countSelectable(visible)))
	ordinal := 0
	for i := 0; i < start; i++ {
		if !visible[i].Separator {
			ordinal++
		}
	}
	for i := start; i < start+size; i++ {
		option := visible[i]
		if option.Separator {
			lines = append(lines, Dim("  ──── "+option.Label+" ────"))
			continue
		}
		ordinal++
		text := fmt.Sprintf("%*d. %s", digits, ordinal, option.Label)
		pointer := " "
		if i == cursor {
			pointer = Cyan("❯")
		}
		suffix := ""
		if option.Hint != "" {
			suffix = "  " + Dim(option.Hint)
		}
		if option.Disabled || i != cursor {
			text = Dim(text)
		}
		lines = append(lines, pointer+" "+text+suffix)
	}
	if start > 0 || start+size < len(visible) {
		hidden := countSelectable(visible) - countSelectable(visible[start:start+size])
		lines = append(lines, Dim(fmt.Sprintf("  … 还有 %d 项（继续敲字缩小范围）", hidden)))
	}
	return lines
}

func countSelectable(list []Option) int {
	count := 0
	for _, option := range list {
		if !option.Separator {
			count++
		}
	}
	return count
}

// frame 把一帧渲染成字节。
//
// **行尾必须是 `\r\n`，不能只用 `\n`**：raw 模式关掉了 OPOST，`\n` 在终端上只下移
// 一行、不回列 0，于是每一行都从上一行结束的列开始写 —— 表现出来就是选项越排越往右
// （真机截图里第一行 50 列宽，选项就从第 50 列开始）。同时在帧首补一个 `\r`，
// 把上一次按键留下的列位置归零。
func frame(lines []string) string {
	width := terminalWidth()
	trimmed := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed = append(trimmed, truncateToWidth(line, width))
	}
	return "\r" + strings.Join(trimmed, "\r\n") + "\r\n"
}

// terminalWidth 拿终端宽度；拿不到就返回 0（表示不截断）。
func terminalWidth() int {
	file := os.Stdout
	if Out != os.Stdout {
		return 0 // 输出被重定向（测试或管道）时不按终端宽度截断
	}
	width, _, err := term.GetSize(int(file.Fd()))
	if err != nil || width <= 0 {
		return 0
	}
	return width
}

// truncateToWidth 把一行按**显示宽度**截到终端宽度以内。
//
// 必须截断：一行折行后占两行，而 clearDrawn 是按「逻辑行数」上移的，行数对不上就会
// 把上一帧的残字留在屏幕上。
func truncateToWidth(line string, width int) string {
	if width <= 0 || DisplayWidth(line) <= width {
		return line
	}
	// 留一列给省略号，逐步裁到放得下（CJK 字符占两列，按 rune 裁不会切断半个字）
	runes := []rune(line)
	for len(runes) > 0 {
		runes = runes[:len(runes)-1]
		candidate := string(runes) + "…"
		if DisplayWidth(candidate) <= width {
			return candidate
		}
	}
	return ""
}

func clearDrawn(count int) {
	// 先回列 0：光标停在行中间时（比如上一个输入留下的 `› 1`），
	// 不归零就直接写新一帧，整块会往右飘。
	fmt.Fprint(Out, "\r")
	if count == 0 {
		return
	}
	fmt.Fprintf(Out, "\x1b[%dA", count)
	for i := 0; i < count; i++ {
		fmt.Fprint(Out, "\x1b[2K") // 2K 清整行，与列位置无关
		if i < count-1 {
			fmt.Fprint(Out, "\x1b[1B")
		}
	}
	fmt.Fprintf(Out, "\x1b[%dA\r", count-1)
}

// ── 按键解析 ────────────────────────────────────────────────────────────────

type keyEvent struct {
	name string
	text string
}

// readKey 读一个按键。方向键是 `ESC [ A/B`，Esc 单独一个字节。
func readKey(reader *bufio.Reader) (keyEvent, error) {
	first, err := reader.ReadByte()
	if err != nil {
		return keyEvent{}, err
	}
	switch first {
	case '\r', '\n':
		return keyEvent{name: "enter"}, nil
	case 0x7f, 0x08:
		return keyEvent{name: "backspace"}, nil
	case 0x1b:
		// 方向键在一阵字节里到达；单独一个 Esc 后面不会有内容
		if reader.Buffered() == 0 {
			time.Sleep(2 * time.Millisecond)
		}
		if reader.Buffered() == 0 {
			return keyEvent{name: "escape"}, nil
		}
		second, err := reader.ReadByte()
		if err != nil {
			return keyEvent{name: "escape"}, nil
		}
		if second != '[' && second != 'O' {
			return keyEvent{name: "escape"}, nil
		}
		third, err := reader.ReadByte()
		if err != nil {
			return keyEvent{name: "escape"}, nil
		}
		switch third {
		case 'A':
			return keyEvent{name: "up"}, nil
		case 'B':
			return keyEvent{name: "down"}, nil
		case 'C':
			return keyEvent{name: "right"}, nil
		case 'D':
			return keyEvent{name: "left"}, nil
		}
		return keyEvent{name: "escape"}, nil
	case 0x03: // Ctrl-C
		return keyEvent{}, fmt.Errorf("已取消")
	}
	if first < 0x20 {
		return keyEvent{name: "control"}, nil
	}
	// 多字节 UTF-8：把后续字节补齐
	buffer := []byte{first}
	for len(buffer) < 4 && reader.Buffered() > 0 {
		next, err := reader.Peek(1)
		if err != nil || next[0] < 0x80 || next[0] > 0xbf {
			break
		}
		byteRead, _ := reader.ReadByte()
		buffer = append(buffer, byteRead)
		if len(buffer) >= 2 {
			break
		}
	}
	return keyEvent{text: string(buffer)}, nil
}

// Menu 是「打印编号清单 + 输入编号」的主菜单形态。
//
// 返回被选中的 key（大写）。非法编号会重问，大小写都认。
func Menu(title string, groups []MenuGroup) (string, error) {
	keys := map[string]bool{}
	Note(Cyan("?") + " " + title)
	for index, group := range groups {
		if index > 0 || group.Title != "" {
			Blank()
		}
		if group.Title != "" {
			Note("  " + Dim("──────── "+group.Title+" ────────"))
		}
		for _, item := range group.Items {
			keys[strings.ToUpper(item.Key)] = true
			hint := ""
			if item.Hint != "" {
				hint = "  " + Dim(item.Hint)
			}
			Note(fmt.Sprintf("  %s. %s%s", item.Key, item.Label, hint))
		}
	}
	for {
		value, err := Input("请输入编号", "")
		if err != nil {
			return "", err
		}
		upper := strings.ToUpper(strings.TrimSpace(value))
		if keys[upper] {
			return upper, nil
		}
		Warn("请输入 " + strings.Join(sortedKeys(keys), " / "))
	}
}

// MenuGroup 是菜单里的一组条目。
type MenuGroup struct {
	Title string
	Items []MenuItem
}

// MenuItem 是一条菜单项。
type MenuItem struct {
	Key   string
	Label string
	Hint  string
}

func sortedKeys(keys map[string]bool) []string {
	// 固定顺序：数字升序在前，字母在后 —— 比随机 map 顺序好用
	digits := []string{}
	letters := []string{}
	for key := range keys {
		if key >= "0" && key <= "9" {
			digits = append(digits, key)
			continue
		}
		letters = append(letters, key)
	}
	for i := 0; i < len(digits); i++ {
		for j := i + 1; j < len(digits); j++ {
			if digits[j] < digits[i] {
				digits[i], digits[j] = digits[j], digits[i]
			}
		}
	}
	for i := 0; i < len(letters); i++ {
		for j := i + 1; j < len(letters); j++ {
			if letters[j] < letters[i] {
				letters[i], letters[j] = letters[j], letters[i]
			}
		}
	}
	return append(append([]string{}, digits...), letters...)
}
