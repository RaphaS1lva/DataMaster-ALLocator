"""Observabilidade mínima e honesta da camada de LLM.

POR QUÊ ESTE MÓDULO EXISTE
--------------------------
O v1 do ALLocator tinha apenas um contador em memória ("chamei o modelo N vezes").
Isso é insuficiente para defender a arquitetura: não dizia QUAL modelo respondeu,
QUANTO tempo levou, QUANTOS tokens custou, nem POR QUE o roteador escolheu aquele
provedor. Sem esses números não há como afirmar "o modelo local resolve 95% dos
casos em Xms" - só há opinião.

Aqui registramos cada tentativa (inclusive as puladas pelo disjuntor) com duração,
tokens e o motivo da decisão de roteamento. `resumo()` transforma isso em
latência p50/p95 por provedor/modelo - que é exatamente o dado que sustenta a
escolha de rodar um modelo pequeno local com fallback de nuvem.

Guardamos em memória (deque limitado, sem I/O de disco no caminho crítico) e
emitimos uma linha JSON por evento via `logging`, para quem quiser agregar fora.
"""

from __future__ import annotations

import json
import logging
import math
import time
from collections import deque
from contextlib import contextmanager
from typing import Any, Iterator, Sequence

logger = logging.getLogger("allocator.trace")

# Eventos ficam em memória apenas para o resumo do portal; 500 é o suficiente
# para cobrir uma sessão de leitura inteira sem virar vazamento de memória.
MAX_EVENTOS = 500


def _percentil(valores: Sequence[float], p: float) -> float:
    """Percentil por interpolação linear.

    Implementado à mão de propósito: `statistics.quantiles` exige n>=2 e
    levanta exceção com amostras pequenas - e amostra pequena é a regra aqui
    (uma leitura pode fazer 3 chamadas de LLM).
    """
    if not valores:
        return 0.0
    ordenados = sorted(valores)
    k = (len(ordenados) - 1) * p
    piso, teto = math.floor(k), math.ceil(k)
    if piso == teto:
        return float(ordenados[int(k)])
    return float(ordenados[piso] + (ordenados[teto] - ordenados[piso]) * (k - piso))


class Trace:
    """Coletor de eventos com medição de duração por etapa."""

    def __init__(self, maxlen: int = MAX_EVENTOS) -> None:
        self._eventos: deque[dict[str, Any]] = deque(maxlen=maxlen)
        self._inicio = time.perf_counter()

    # ------------------------------------------------------------------ eventos
    def evento(self, nome: str, **campos: Any) -> dict[str, Any]:
        """Registra um evento pontual e devolve o registro gravado.

        `t_rel_ms` é o tempo desde a criação do trace: permite reconstruir a
        linha do tempo de uma requisição sem depender de relógio de parede.
        """
        registro: dict[str, Any] = {
            "ts": time.time(),
            "t_rel_ms": round((time.perf_counter() - self._inicio) * 1000, 2),
            "evento": nome,
        }
        registro.update(campos)
        self._eventos.append(registro)
        # `default=str` evita que um objeto exótico (ex.: exceção) derrube o log.
        logger.info(json.dumps(registro, ensure_ascii=False, default=str))
        return registro

    @contextmanager
    def contexto(self, nome: str, **campos: Any) -> Iterator[dict[str, Any]]:
        """Mede a duração de um bloco e registra sucesso OU exceção.

        O dict cedido pelo `yield` é mesclado ao evento final: permite ao bloco
        acrescentar campos descobertos durante a execução (tokens, modelo real
        usado etc.) sem precisar de outra chamada a `evento`.
        """
        extras: dict[str, Any] = {}
        inicio = time.perf_counter()
        try:
            yield extras
        except Exception as exc:  # noqa: BLE001 - re-levantada logo abaixo
            campos_finais = {**campos, **extras}
            campos_finais.update(
                ok=False,
                duracao_ms=round((time.perf_counter() - inicio) * 1000, 2),
                erro=f"{type(exc).__name__}: {exc}",
            )
            self.evento(nome, **campos_finais)
            raise
        campos_finais = {**campos, **extras}
        campos_finais.update(ok=True, duracao_ms=round((time.perf_counter() - inicio) * 1000, 2))
        self.evento(nome, **campos_finais)

    # ------------------------------------------------------------------ leitura
    def eventos(self) -> list[dict[str, Any]]:
        """Cópia dos eventos em memória (mais antigo primeiro)."""
        return list(self._eventos)

    def limpar(self) -> None:
        self._eventos.clear()
        self._inicio = time.perf_counter()

    def resumo(self) -> dict[str, Any]:
        """Agrega por provedor/modelo: chamadas, tokens, p50/p95, erros.

        Só conta como "chamada" o evento que declarou `ok` (sucesso ou falha de
        uma tentativa real). Decisões de roteamento (pular por disjuntor, por
        exemplo) entram em `decisoes`, para não inflar a contagem de chamadas.
        """
        agregados: dict[str, dict[str, Any]] = {}
        decisoes: dict[str, int] = {}

        for ev in self._eventos:
            decisao = ev.get("decisao")
            if decisao:
                decisoes[str(decisao)] = decisoes.get(str(decisao), 0) + 1
            provedor = ev.get("provedor")
            if not provedor or ev.get("ok") is None:
                continue
            chave = f"{provedor}/{ev.get('modelo') or '-'}"
            alvo = agregados.setdefault(
                chave,
                {
                    "chamadas": 0,
                    "sucessos": 0,
                    "erros": 0,
                    "tokens_entrada": 0,
                    "tokens_saida": 0,
                    "ultimo_erro": None,
                    "_latencias": [],
                },
            )
            alvo["chamadas"] += 1
            if ev.get("ok"):
                alvo["sucessos"] += 1
            else:
                alvo["erros"] += 1
                alvo["ultimo_erro"] = ev.get("erro")
            alvo["tokens_entrada"] += int(ev.get("tokens_entrada") or 0)
            alvo["tokens_saida"] += int(ev.get("tokens_saida") or 0)
            if ev.get("duracao_ms") is not None:
                alvo["_latencias"].append(float(ev["duracao_ms"]))

        for alvo in agregados.values():
            latencias = alvo.pop("_latencias")
            alvo["latencia_p50_ms"] = round(_percentil(latencias, 0.50), 2)
            alvo["latencia_p95_ms"] = round(_percentil(latencias, 0.95), 2)
            alvo["latencia_media_ms"] = round(sum(latencias) / len(latencias), 2) if latencias else 0.0

        return {
            "eventos_em_memoria": len(self._eventos),
            "por_modelo": agregados,
            "decisoes_roteamento": decisoes,
        }


# Trace de processo. A camada de LLM é chamada de vários pontos (rotas FastAPI,
# scripts de eval); um singleton evita ter de passar o trace por parâmetro em
# todas as assinaturas só para observabilidade.
TRACE = Trace()


def evento(nome: str, **campos: Any) -> dict[str, Any]:
    """Atalho para `TRACE.evento`."""
    return TRACE.evento(nome, **campos)


@contextmanager
def contexto(nome: str, **campos: Any) -> Iterator[dict[str, Any]]:
    """Atalho para `TRACE.contexto`."""
    with TRACE.contexto(nome, **campos) as extras:
        yield extras


def resumo() -> dict[str, Any]:
    """Atalho para `TRACE.resumo`."""
    return TRACE.resumo()
