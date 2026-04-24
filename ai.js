// Hosted AI providers for the webapp cover-letter feature.
//
// Calls go directly from the user's browser to the model API with their own
// BYOK key — nothing is ever proxied. That keeps the static site genuinely
// static (no backend to hack) and makes it impossible for us to see anyone's
// key or prompts. Tradeoff: CORS is at the provider's mercy. Anthropic and
// OpenAI both allow browser requests; Gemini does too via generativelanguage.
//
// Each provider exposes the same shape: `generate({ system, user, apiKey,
// model, onChunk })` → final text. `onChunk` is called with the accumulating
// text for streaming UIs.

(function initJobTrailAI(global) {
  const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
  const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
  // DeepSeek exposes an OpenAI-compatible chat/completions endpoint, so we
  // reuse the exact same SSE parsing path as OpenAI — only URL + model differ.
  const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

  function joinStreamSSE(textAcc, newText) {
    return textAcc + newText;
  }

  async function readEventStream(response, extractChunk, onChunk) {
    // Shared SSE reader for Anthropic and OpenAI. `extractChunk` returns the
    // delta text for one parsed event, or null if the event has no text.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let acc = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Process complete SSE frames (terminated by blank line).
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = frame.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            const chunk = extractChunk(json);
            if (chunk) {
              acc = joinStreamSSE(acc, chunk);
              if (onChunk) onChunk(acc);
            }
          } catch (_) { /* skip malformed frame */ }
        }
      }
    }
    return acc;
  }

  async function generateAnthropic(opts) {
    const { system, user, apiKey, model, onChunk } = opts;
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Required for browser-origin calls.
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: model || "claude-sonnet-4-5",
        max_tokens: 800,
        system,
        stream: true,
        messages: [{ role: "user", content: user }]
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 300) || res.statusText}`);
    }
    return readEventStream(res, (event) => {
      // content_block_delta → { delta: { type: "text_delta", text: "..." } }
      if (event && event.type === "content_block_delta" && event.delta && event.delta.type === "text_delta") {
        return event.delta.text || "";
      }
      return null;
    }, onChunk);
  }

  async function generateOpenAI(opts) {
    const { system, user, apiKey, model, onChunk } = opts;
    const res = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "gpt-4o-mini",
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300) || res.statusText}`);
    }
    return readEventStream(res, (event) => {
      // choices[0].delta.content
      const choice = event && event.choices && event.choices[0];
      return choice && choice.delta && choice.delta.content ? choice.delta.content : null;
    }, onChunk);
  }

  async function generateDeepSeek(opts) {
    // DeepSeek's API is a drop-in for OpenAI's chat/completions, including the
    // SSE stream frame shape (`choices[0].delta.content`). We keep a separate
    // function rather than reusing generateOpenAI so the error prefix makes
    // failures easy to attribute in logs.
    const { system, user, apiKey, model, onChunk } = opts;
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || "deepseek-chat",
        stream: true,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`DeepSeek ${res.status}: ${txt.slice(0, 300) || res.statusText}`);
    }
    return readEventStream(res, (event) => {
      const choice = event && event.choices && event.choices[0];
      return choice && choice.delta && choice.delta.content ? choice.delta.content : null;
    }, onChunk);
  }

  async function generateGemini(opts) {
    // Gemini's streaming SSE uses a different frame format and the v1beta
    // endpoint expects the key as a query param. Using non-streaming here
    // because Gemini's SSE wrapping is fiddly and the letters are short.
    const { system, user, apiKey, model, onChunk } = opts;
    const m = model || "gemini-1.5-flash-latest";
    const url = `${GEMINI_URL}/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { role: "system", parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Gemini ${res.status}: ${txt.slice(0, 300) || res.statusText}`);
    }
    const json = await res.json();
    const text = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    const out = text.map((p) => p.text || "").join("");
    if (onChunk) onChunk(out);
    return out;
  }

  async function generate(opts) {
    const provider = (opts && opts.provider) || "none";
    if (!opts || !opts.apiKey) throw new Error("Missing API key.");
    if (provider === "anthropic") return generateAnthropic(opts);
    if (provider === "openai") return generateOpenAI(opts);
    if (provider === "gemini") return generateGemini(opts);
    if (provider === "deepseek") return generateDeepSeek(opts);
    throw new Error(`Unsupported provider: ${provider}`);
  }

  global.JobTrailAI = { generate };
})(typeof self !== "undefined" ? self : window);
