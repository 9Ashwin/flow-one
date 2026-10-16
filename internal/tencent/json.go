// Copyright (c) 2026 9Ashwin
// SPDX-License-Identifier: MIT

package tencent

import (
	"bytes"
	"encoding/json"
	"math"
)

// 腾讯上游的目录报文是「字段随产品线浮动」的动态形状（同一个字段在不同产品线里
// 有时是字符串、有时缺失），所以按 map[string]any 读而不是定死结构体：一个字段
// 类型不对不该让整份目录消失。这与 Node 版的取舍一致。
//
// 数字一律走 json.Number（UseNumber），不要用 float64 兜：窗口大小动辄百万，
// 原样保留比换算更安全。

// decodeObject 把响应体解成 JSON 对象；不是对象（或坏 JSON / 空体）返回 nil。
func decodeObject(payload []byte) map[string]any {
	if len(bytes.TrimSpace(payload)) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var body any
	if err := decoder.Decode(&body); err != nil {
		return nil
	}
	object, _ := body.(map[string]any)
	return object
}

// dataOf 取 body.data；缺失或为 null 时返回 nil。
func dataOf(body map[string]any) any {
	if body == nil {
		return nil
	}
	return body["data"]
}

// objectOf 要求值是对象。
func objectOf(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	return object, ok
}

// arrayOf 要求值是数组；不是数组时返回 nil（等价于空数组）。
func arrayOf(value any) []any {
	array, _ := value.([]any)
	return array
}

// stringOf 是**严格**的字符串判断：Node 版在这些位置用的是 typeof x === 'string'，
// 数字 id 一律不算（否则会多出上游没打算给的模型）。
func stringOf(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

// numberOf 要求值是数字（Node 版同样是 typeof === 'number'）。
func numberOf(value any) (float64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := number.Float64()
	if err != nil || math.IsNaN(parsed) {
		return 0, false
	}
	return parsed, true
}

// boolOf 要求值是布尔。
func boolOf(value any) (bool, bool) {
	flag, ok := value.(bool)
	return flag, ok
}

// firstNonNull 取 keys 里第一个「键在且不是 null」的值（Node 版的 `??` 链）。
func firstNonNull(body map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		if value, ok := body[key]; ok && value != nil {
			return value, true
		}
	}
	return nil, false
}
