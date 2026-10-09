"""List prices of the Gemini models the director calls, for cost estimates.

Prices are USD per 1M tokens, checked on 2026-10-06 at
https://ai.google.dev/gemini-api/docs/pricing and
https://cloud.google.com/vertex-ai/generative-ai/pricing. The Gemini API and
the Vertex AI global endpoint charge the same; other Vertex AI locations add
10%. Text, image, video and audio input share one rate for these models,
thinking tokens are billed as output, and no extra per-call or per-step
charge for agentic video processing is published.

A call is billed only when it returns a response, so calls that end in an
API error cost nothing here, while answers retried for being unusable do.
"""

from __future__ import annotations

from collections.abc import Sequence
import dataclasses
import datetime

from google.genai import types

_TOKENS_PER_PRICE_UNIT = 1_000_000
# Vertex AI regional (non-global) endpoints cost 10% more.
_REGIONAL_MARKUP = 1.1


@dataclasses.dataclass(frozen=True)
class Price:
  """USD per 1M tokens of one model from a given day on."""

  # First day the price applies (inclusive).
  since: datetime.date
  input_usd: float
  cached_input_usd: float
  # Answer and thinking tokens.
  output_usd: float


# The 3.6 to 3.8 Flash launch prices end on 2026-12-31.
_FLASH = (
    Price(datetime.date.min, 0.75, 0.075, 3.75),
    Price(datetime.date(2027, 1, 1), 1.50, 0.15, 7.50),
)

PRICES: dict[str, tuple[Price, ...]] = {
    'gemini-3.8-flash': _FLASH,
    'gemini-3.7-flash': _FLASH,
    'gemini-3.6-flash': _FLASH,
    'gemini-3.5-flash-lite': (Price(datetime.date.min, 0.30, 0.03, 2.50),),
}


def price_on(model: str, day: datetime.date) -> Price | None:
  """Returns the list price of a model on a day, or None if unknown."""
  current = None
  for price in PRICES.get(model, ()):
    if price.since <= day:
      current = price
  return current


def call_cost_usd(
    model: str,
    usage: types.GenerateContentResponseUsageMetadata | None,
    *,
    regional: bool,
    day: datetime.date,
) -> float | None:
  """Returns the list price of one finished Gemini call.

  Args:
    model: The model the call asked for.
    usage: The last usage metadata of the call's stream (the totals; stream
      chunks are cumulative, so they are never added up).
    regional: Whether the call went to a Vertex AI regional endpoint.
    day: The day of the call, which selects the price period.

  Returns:
    The cost in USD, or None when the model has no known price or the call
    reported no usage.
  """
  price = price_on(model, day)
  if price is None or usage is None:
    return None
  # Tool-use tokens are the frames and audio the agentic mode fetched.
  prompt = (usage.prompt_token_count or 0) + (
      usage.tool_use_prompt_token_count or 0
  )
  cached = min(usage.cached_content_token_count or 0, prompt)
  output = (usage.candidates_token_count or 0) + (
      usage.thoughts_token_count or 0
  )
  usd = (
      (prompt - cached) * price.input_usd
      + cached * price.cached_input_usd
      + output * price.output_usd
  ) / _TOKENS_PER_PRICE_UNIT
  return usd * _REGIONAL_MARKUP if regional else usd


def cache_write_cost_usd(
    model: str, token_count: int, *, regional: bool, day: datetime.date
) -> float | None:
  """Returns the list price of creating a Context Cache.

  Creating a cache bills its tokens once at the input rate. The hourly
  storage charge of the cache is not included.

  Args:
    model: The model the cache was created for.
    token_count: The cache's token count as the API reported it.
    regional: Whether the call went to a Vertex AI regional endpoint.
    day: The day of the call, which selects the price period.

  Returns:
    The cost in USD, or None when the model has no known price.
  """
  price = price_on(model, day)
  if price is None:
    return None
  usd = token_count * price.input_usd / _TOKENS_PER_PRICE_UNIT
  return usd * _REGIONAL_MARKUP if regional else usd


def total_usd(costs: Sequence[float | None]) -> float | None:
  """Adds call costs; one unknown cost makes the total unknown."""
  known = [cost for cost in costs if cost is not None]
  if len(known) < len(costs):
    return None
  return sum(known)
