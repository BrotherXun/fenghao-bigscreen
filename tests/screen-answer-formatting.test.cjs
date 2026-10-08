const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadScreen } = require("./helpers/screen-harness.cjs");

test("回答区句中加粗不继承容器的块级布局", () => {
  const { screen } = loadScreen();
  const formatted = screen.formatAssistantMessage("如果是 **钢筋绑扎** 的话，要先检查防护。");
  assert.equal(formatted, "如果是 <strong>钢筋绑扎</strong> 的话，要先检查防护。");

  const css = fs.readFileSync(path.join(__dirname, "../public/screen.css"), "utf8");
  assert.equal(/\.assistant-answer-stream\s+strong\s*\{[^}]*display:\s*block\b/.test(css), false,
    "句中 Markdown strong 不能被回答容器的 display:block 规则命中");
  assert.equal(/\.assistant-answer-stream\s*>\s*strong\s*\{[^}]*display:\s*block\b/.test(css), true,
    "回答容器仍保留原有块级布局");
});

test("回答格式化保留真实换行且先转义 HTML 再渲染加粗", () => {
  const { screen } = loadScreen();
  assert.equal(screen.formatAssistantMessage("第一段 **检查防护**。\n\n下一段 <img src=x onerror='alert(1)'> & \"提示\""),
    "第一段 <strong>检查防护</strong>。<br><br>下一段 &lt;img src=x onerror=&#039;alert(1)&#039;&gt; &amp; &quot;提示&quot;");
});

test("播报预览去掉加粗标记且不修改原回答或技术符号", () => {
  const { screen } = loadScreen();
  const original = "如果是 **钢筋绑扎** 的话，要先检查防护。2 * 3，C#，a > b。";
  screen.assistantVoiceState = "playing";
  screen.assistantLiveAnswer = original;
  assert.equal(screen.voiceTranscript, "如果是 钢筋绑扎 的话，要先检查防护。2 * 3，C#，a > b。");
  assert.equal(screen.voiceLatestAnswer, original);
  assert.equal(screen.assistantLiveAnswer, original);
});
