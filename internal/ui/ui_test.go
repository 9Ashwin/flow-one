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
