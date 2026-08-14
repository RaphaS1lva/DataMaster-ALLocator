"""Observabilidade do ALLocator (traços, latências e decisões de roteamento)."""

from __future__ import annotations

from .trace import TRACE, Trace, contexto, evento, resumo

__all__ = ["TRACE", "Trace", "contexto", "evento", "resumo"]
