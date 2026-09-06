const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("安全问答提示词适合语音播报且保留施工安全边界", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../server.cjs"), "utf8");
  const match = source.match(/const assistantSystemPrompt = "([^"]+)";/);
  assert.ok(match, "系统提示词必须存在");
  const prompt = match[1];

  assert.match(prompt, /施工和工程安全/);
  assert.match(prompt, /语音播报/);
  assert.match(prompt, /1至3句、80字以内/);
  assert.match(prompt, /停止作业、撤离危险区域、报告现场负责人/);
  assert.match(prompt, /只追问一个最必要的问题/);
});
