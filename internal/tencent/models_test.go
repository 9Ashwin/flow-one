// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func idsOf(models []catalogModel) []string {
	ids := make([]string, 0, len(models))
	for _, model := range models {
		ids = append(ids, model.model.ID)
	}
	return ids
}

// 顺序即优先级：主对话 agent 引用的模型最前，其余 data.models 跟上，最后补试用横幅。
func TestParseModelsOrder(t *testing.T) {
	body := decodeObject([]byte(`{"code":0,"data":{
		"models":[{"id":"glm-5.3"},{"id":"hy4-preview-f"},{"id":"deepseek-v4.1-flash"}],
		"agents":[{"name":"craft","models":["deepseek-v4.1-flash"]},{"name":"cli","models":["hy4-preview-f","glm-5.3"]}],
		"productFeaturesConfig":{"ModelTrialBanner":{"banners":[{"targetModelId":"trial-model"}]}}
	}}`))

	models := parseModels(body)
	assert.Equal(t, []string{"hy4-preview-f", "glm-5.3", "deepseek-v4.1-flash", "trial-model"}, idsOf(models),
		"cli 优先于 craft；已出现的不重复；试用横幅排最后")
}

// 补全 / NES / 文生图这类条目不是对话模型，混进清单会让用户选中一个必然失败的 ID。
func TestParseModelsFiltersNonChatEntries(t *testing.T) {
	body := decodeObject([]byte(`{"code":0,"data":{"models":[
		{"id":"nes-next-edit"},
		{"id":"completion-fast"},
		{"id":"codewise-1"},
		{"id":"auto"},
		{"id":"default"},
		{"id":"with-extra","supportsExtra":true},
		{"id":"tiny-output","maxOutputTokens":256},
		{"id":"image-model","tags":["text-to-image"]},
		{"id":"glm-5.3"}
	]}}`))

	assert.Equal(t, []string{"glm-5.3"}, idsOf(parseModels(body)))
}

// 元数据映射：窗口 / 输出上限 / 视觉 / 档位，名字缺省用 id。
func TestParseModelsMeta(t *testing.T) {
	body := decodeObject([]byte(`{"code":0,"data":{"models":[{
		"id":"hy4-preview-f","name":"Hy4 Preview F",
		"maxInputTokens":200000,"maxOutputTokens":8192,"supportsImages":true,
		"reasoning":{"supportedEfforts":["low","","high"],"defaultEffort":"high"}
	}]}}`))

	models := parseModels(body)
	require.Len(t, models, 1)
	model := models[0].model
	assert.Equal(t, "hy4-preview-f", model.ID)
	assert.Equal(t, "Hy4 Preview F", model.Name)
	assert.Equal(t, 200000, model.ContextWindow)
	assert.Equal(t, 8192, model.MaxOutputTokens)
	assert.True(t, model.SupportsImages)
	assert.Equal(t, []string{"low", "high"}, model.Efforts, "空档位要滤掉")
	assert.Equal(t, "high", models[0].defaultEffort)
	assert.False(t, model.Free)

	// 没有元数据时名字退回 id
	models = parseModels(decodeObject([]byte(`{"data":{"models":[{"id":"glm-5.3"}]}}`)))
	require.Len(t, models, 1)
	assert.Equal(t, "glm-5.3", models[0].model.Name)
	assert.Zero(t, models[0].model.ContextWindow)
}

// agent 的 models 不是字符串、字段类型不对时跳过，而不是让整份目录消失。
func TestParseModelsToleratesOddShapes(t *testing.T) {
	body := decodeObject([]byte(`{"data":{
		"models":[{"id":123},{"id":"glm-5.3","maxOutputTokens":"8192"},null,"nonsense"],
		"agents":[{"name":"cli","models":[42,"glm-5.3"]}]
	}}`))

	models := parseModels(body)
	assert.Equal(t, []string{"glm-5.3"}, idsOf(models))
	assert.Zero(t, models[0].model.MaxOutputTokens, "字符串形式的上限不算（Node 版是 typeof === number）")

	assert.Empty(t, parseModels(nil))
	assert.Empty(t, parseModels(map[string]any{"data": "不是对象"}))
}
