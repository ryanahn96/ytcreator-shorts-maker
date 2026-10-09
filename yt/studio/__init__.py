"""Agentic Shorts 생성 스튜디오 core package.

Terms follow the glossary in CONTEXT.md (Source Video, Transcript Word,
Editorial Prompt, Scenario, Clip, Subcut, Look, Audio Transition).

Modules:
  config: environment-driven settings and tunable defaults.
  models: API/domain models shared by the backend and the frontend contract.
  ingestion: uploaded media probes, analysis proxy and Transcript Words.
  prompts: default Editorial Prompt, system instruction and response schema.
  gemini: Gemini client for the API key or Vertex AI backend, ADC check.
  pricing: Gemini list prices and the cost of one analysis.
  director: Gemini agentic video understanding call and result validation.
  layout: template geometry shared by the render and the preview.
  fonts: bundled Korean fonts for Headlines and captions.
  composer: Subcut quantization, Audio Transitions, captions and ffmpeg.
  storage: server-side workspace for uploads and renders.
"""
