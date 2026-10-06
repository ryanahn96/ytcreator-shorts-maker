"""Agentic Shortform Jump-cut Studio core package.

Terms follow the glossary in CONTEXT.md (Source Video, Transcript Word,
Editorial Prompt, Scenario, Clip, Subcut, Framing Layout, Audio Transition).

Modules:
  config: environment-driven settings and tunable defaults.
  models: API/domain models shared by the backend and the frontend contract.
  ingestion: YouTube metadata, caption Transcript Words, uploaded media probe.
  prompts: default Editorial Prompt, system instruction and response schema.
  gemini: Gemini client for the API key or Vertex AI backend, ADC check.
  director: Gemini agentic video understanding call and result validation.
  composer: Subcut quantization, Audio Transitions, captions and ffmpeg.
  storage: server-side workspace for uploaded Source Videos and renders.
"""
