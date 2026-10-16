// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package ui

import (
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDisplayWidthIgnoresColorAndCountsCJKAsTwo(t *testing.T) {
	// 边框对齐全靠它：颜色码零宽，中文占两列
	assert.Equal(t, 3, DisplayWidth("abc"))
	assert.Equal(t, 4, DisplayWidth("中文"))
	assert.Equal(t, 4, DisplayWidth(Gray("中文")), "颜色码不能算进宽度")
	assert.Equal(t, 4, DisplayWidth(Cyan("a")+Gray("中")+"b"))
}

func TestBoxAlignsEveryLine(t *testing.T) {
	var sb strings.Builder
	old := Out
	Out = &sb
	defer func() { Out = old }()

	Box([]string{"短", Gray("这一行更长一些")}, Cyan)

	lines := strings.Split(strings.TrimRight(sb.String(), "\n"), "\n")
	require.Len(t, lines, 4)
	width := DisplayWidth(lines[0])
	for _, line := range lines {
		assert.Equal(t, width, DisplayWidth(line), "每一行的显示宽度必须一致：%q", line)
	}
}

func TestSelectStopsWithoutTTY(t *testing.T) {
	// 无 TTY 时要给出明确错误，而不是挂在等按键上
	restore := SetInputForTest(strings.NewReader(""), false)
	defer restore()
	_, err := Select("选一个", []Option{{Label: "A", Value: "a"}}, SelectOptions{})
	require.Error(t, err)
	assert.Contains(t, err.Error(), "TTY")
}

func TestSelectFiltersWhileTyping(t *testing.T) {
	// 边打边筛：敲 "glm" 只剩一条，回车选中它（这是模型清单最关键的手感）
	keys := "\x1b[B" + "glm" + "\r" // ↓（先离开首项）再敲字筛选，回车
	restore := SetInputForTest(strings.NewReader(keys), true)
	defer restore()
	old := Out
	Out = io.Discard
	defer func() { Out = old }()

	value, err := Select("用哪个模型？", []Option{
		{Label: "cn/deepseek-v4.1-flash", Value: "cn"},
		{Label: "oc/deepseek-v4.1-flash-free", Value: "oc"},
		{Label: "intl/glm-5.3", Value: "glm"},
	}, SelectOptions{Filterable: true, Window: 5})
	require.NoError(t, err)
	assert.Equal(t, "glm", value)
}

func TestSelectSkipsSeparatorRows(t *testing.T) {
	// 分组标题不可选、光标跳过：初始光标必须落在第一个真实项上
	restore := SetInputForTest(strings.NewReader("\r"), true)
	defer restore()
	old := Out
	Out = io.Discard
	defer func() { Out = old }()

	value, err := Select("用哪个模型？", []Option{
		{Label: "免费模型（1 个）", Separator: true},
		{Label: "oc/deepseek-v4.1-flash-free", Value: "free"},
		{Label: "其余模型（1 个）", Separator: true},
		{Label: "cn/deepseek-v4.1-flash", Value: "paid"},
	}, SelectOptions{Filterable: true})
	require.NoError(t, err)
	assert.Equal(t, "free", value)
}

func TestPasswordRefusesWithoutTTY(t *testing.T) {
	restore := SetInputForTest(strings.NewReader(""), false)
	defer restore()
	_, err := Password("粘贴 key")
	require.Error(t, err)
}

func TestSelectFrameUsesCarriageReturns(t *testing.T) {
	// 真机踩过：raw 模式关掉 OPOST 之后 `\n` 只下移不回列 0，于是每一行都从上一行
	// 结束的列开始写，选项越排越往右（用户截图里选项从第 50 列开始）。
	// 所以帧必须用 `\r\n`，且帧首要有一个 `\r` 把上一次按键留下的列位置归零。
	keys := "\x1b[B" + "\r" // ↓ 再回车
	restore := SetInputForTest(strings.NewReader(keys), true)
	defer restore()
	var out strings.Builder
	old := Out
	Out = &out
	defer func() { Out = old }()

	_, err := Select("接哪一家？", []Option{
		{Label: "WorkBuddy 国内版", Value: "cn"},
		{Label: "OpenCode 免费档", Value: "oc"},
	}, SelectOptions{})
	require.NoError(t, err)

	rendered := out.String()
	assert.Contains(t, rendered, "\r", "帧首要有回车，把列位置归零")
	// 除最后一行外，每一行之间都必须是 \r\n；出现裸 \n（前面不是 \r）就说明会往右飘
	for i := 0; i < len(rendered); i++ {
		if rendered[i] == '\n' {
			require.Greater(t, i, 0)
			assert.Equal(t, byte('\r'), rendered[i-1], "行尾必须是 \\r\\n，不能是裸 \\n")
		}
	}
}

func TestFrameStartsWithCarriageReturnAndTruncates(t *testing.T) {
	// 输出不是真终端时（测试/管道）按 0 宽度处理 = 不截断
	assert.Equal(t, "\ra\r\nb\r\n", frame([]string{"a", "b"}))

	// 超宽行要按**显示宽度**截断：折行会让 clearDrawn 的行数算错，留下残字
	assert.Equal(t, "你好…", truncateToWidth("你好世界啊", 5)) // 4 列 + 省略号 1 列
	assert.Equal(t, "abcdef", truncateToWidth("abcdef", 10))
	assert.Equal(t, "abcdef", truncateToWidth("abcdef", 0), "宽度未知时不截断")
}
