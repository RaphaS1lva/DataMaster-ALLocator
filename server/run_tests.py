#!/usr/bin/env python
"""
Executor de testes do servidor. Roda COM ou SEM pytest instalado.

Por que existe: a máquina de desenvolvimento deste projeto está atrás de um
proxy corporativo que bloqueia o PyPI (SSL handshake failure), então `pip
install pytest` não funciona. Mas os testes de LÓGICA - clusterização de
colunas, parsing de número, guardrails anti-injeção, adaptador de balancete,
são justamente os mais críticos e precisam rodar em qualquer lugar.

A solução é um shim mínimo da API de pytest que usamos (fixture,
mark.parametrize, raises, approx, skip), injetado em `sys.modules` ANTES de
importar os módulos de teste. Onde o pytest real existe (o notebook servidor,
o CI), ele é usado e o shim nem é criado.

Uso:
    python server/run_tests.py                 # tudo
    python server/run_tests.py balancete       # só os que casam com o filtro
    python server/run_tests.py -v
"""
from __future__ import annotations

import importlib.util
import inspect
import sys
import traceback
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

RAIZ = Path(__file__).resolve().parent
sys.path.insert(0, str(RAIZ))


# ---------------------------------------------------------------------------
# Shim de pytest - só entra em cena se o pytest real não estiver disponível
# ---------------------------------------------------------------------------
class _Pulado(Exception):
    """Equivalente a pytest.skip()."""


def _instalar_shim() -> ModuleType:
    mod = ModuleType("pytest")

    def fixture(func=None, /, **kwargs):
        """Marca a função como fixture. O runner resolve por NOME do parâmetro.

        Suporta `autouse=True` e fixtures GERADORAS (com `yield`), que é o
        padrão para setup/teardown - ex.: zerar o estado do disjuntor antes e
        depois de cada teste.
        """
        def deco(f):
            f.__e_fixture__ = True
            f.__autouse__ = bool(kwargs.get("autouse"))
            f.__escopo__ = kwargs.get("scope", "function")
            return f
        return deco(func) if callable(func) else deco

    def skip(motivo: str = "", **_kw):
        raise _Pulado(motivo)

    def fail(motivo: str = "", **_kw):
        raise AssertionError(motivo)

    class _Raises:
        def __init__(self, esperado, match: str | None = None):
            self.esperado = esperado
            self.match = match
            self.value: BaseException | None = None

        def __enter__(self):
            return self

        def __exit__(self, tipo, valor, _tb):
            if tipo is None:
                raise AssertionError(f"esperava {self.esperado!r}, nada foi levantado")
            if not issubclass(tipo, self.esperado):
                return False
            self.value = valor
            if self.match:
                import re
                if not re.search(self.match, str(valor)):
                    raise AssertionError(
                        f"mensagem {str(valor)!r} não casa com {self.match!r}")
            return True

    class _Approx:
        def __init__(self, valor, abs=None, rel=None):  # noqa: A002
            self.valor = valor
            self.abs = abs if abs is not None else 1e-6
            self.rel = rel

        def __eq__(self, outro):
            try:
                dif = abs(float(outro) - float(self.valor))
            except (TypeError, ValueError):
                return NotImplemented
            tol = self.abs
            if self.rel is not None:
                tol = max(tol, abs(float(self.valor)) * self.rel)
            return dif <= tol

        def __repr__(self):
            return f"approx({self.valor}, abs={self.abs})"

    class _Mark:
        def parametrize(self, nomes, valores, **_kw):
            def deco(f):
                f.__parametrize__ = (nomes, list(valores))
                return f
            return deco

        def skipif(self, condicao, reason: str = "", **_kw):
            def deco(f):
                if condicao:
                    f.__skip__ = reason or "condição de skipif"
                return f
            return deco

        def __getattr__(self, _nome):  # marcas desconhecidas viram no-op
            def deco(*_a, **_k):
                return lambda f: f
            return deco

    mod.fixture = fixture
    mod.skip = skip
    mod.fail = fail
    mod.raises = _Raises
    mod.approx = _Approx
    mod.mark = _Mark()
    mod.Pulado = _Pulado
    # `pytest.MonkeyPatch` aparece em anotações de tipo; precisa existir mesmo
    # que o módulo de teste não use `from __future__ import annotations`.
    mod.MonkeyPatch = type("MonkeyPatch", (), {})
    sys.modules["pytest"] = mod
    return mod


TEM_PYTEST_REAL = importlib.util.find_spec("pytest") is not None
if not TEM_PYTEST_REAL:
    _instalar_shim()


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
VERDE, VERMELHO, AMARELO, CINZA, RESET = (
    "\033[32m", "\033[31m", "\033[33m", "\033[90m", "\033[0m")


def _carregar(caminho: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(caminho.stem, caminho)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[caminho.stem] = mod
    spec.loader.exec_module(mod)
    return mod


class _MonkeyPatch:
    """Shim de `monkeypatch`: só o que usamos (setattr/setenv/delenv/undo)."""

    def __init__(self) -> None:
        self._desfazer: list[Callable[[], None]] = []

    def setattr(self, alvo: Any, nome: str, valor: Any, raising: bool = True) -> None:
        if isinstance(alvo, str):  # forma "modulo.atributo"
            caminho, _, nome = alvo.rpartition(".")
            alvo = importlib.import_module(caminho)
        existia = hasattr(alvo, nome)
        antigo = getattr(alvo, nome, None)
        if raising and not existia:
            raise AttributeError(f"{alvo!r} não tem {nome!r}")
        setattr(alvo, nome, valor)
        self._desfazer.append(
            (lambda: setattr(alvo, nome, antigo)) if existia
            else (lambda: delattr(alvo, nome)))

    def setenv(self, nome: str, valor: str) -> None:
        import os
        antigo = os.environ.get(nome)
        os.environ[nome] = str(valor)
        self._desfazer.append(
            (lambda: os.environ.__setitem__(nome, antigo)) if antigo is not None
            else (lambda: os.environ.pop(nome, None)))

    def delenv(self, nome: str, raising: bool = True) -> None:
        import os
        if nome not in os.environ:
            if raising:
                raise KeyError(nome)
            return
        antigo = os.environ.pop(nome)
        self._desfazer.append(lambda: os.environ.__setitem__(nome, antigo))

    def setitem(self, dicionario: dict, chave: Any, valor: Any) -> None:
        tinha = chave in dicionario
        antigo = dicionario.get(chave)
        dicionario[chave] = valor
        self._desfazer.append(
            (lambda: dicionario.__setitem__(chave, antigo)) if tinha
            else (lambda: dicionario.pop(chave, None)))

    def undo(self) -> None:
        while self._desfazer:
            self._desfazer.pop()()


# Fixtures embutidas, resolvidas por nome como o pytest faz. `monkeypatch` é
# recriada por teste (nunca compartilhada) e desfeita no fim.
_FIXTURES_EMBUTIDAS = {"monkeypatch": _MonkeyPatch}


def _resolver_fixtures(mod: ModuleType) -> dict[str, Callable]:
    return {
        nome: obj for nome, obj in vars(mod).items()
        if callable(obj) and getattr(obj, "__e_fixture__", False)
    }


def _abrir_fixture(f: Callable) -> tuple[Any, Any]:
    """Executa uma fixture. Devolve `(valor, gerador_para_teardown | None)`.

    Fixture geradora (`yield`) tem setup antes do yield e teardown depois - é
    como se escreve "zere este estado global antes e depois de cada teste".
    """
    if inspect.isgeneratorfunction(f):
        gen = f()
        return next(gen, None), gen
    return f(), None


def _fechar_fixture(gen: Any) -> None:
    if gen is None:
        return
    try:
        next(gen)
    except StopIteration:
        pass


def _chamar(func: Callable, fixtures: dict[str, Callable],
            cache: dict[str, Any], extra: dict[str, Any]) -> None:
    kwargs: dict[str, Any] = {}
    teardowns: list[Any] = []   # geradores a fechar depois do teste
    desfazer: list[Any] = []    # objetos com .undo() (monkeypatch)

    # 1. fixtures autouse - rodam mesmo sem serem pedidas pelo teste
    for nome, f in fixtures.items():
        if getattr(f, "__autouse__", False):
            _, gen = _abrir_fixture(f)
            teardowns.append(gen)

    # 2. parâmetros declarados pelo teste
    for nome in inspect.signature(func).parameters:
        if nome in extra:
            kwargs[nome] = extra[nome]
        elif nome in _FIXTURES_EMBUTIDAS:
            inst = _FIXTURES_EMBUTIDAS[nome]()
            kwargs[nome] = inst
            desfazer.append(inst)
        elif nome in fixtures:
            f = fixtures[nome]
            if getattr(f, "__escopo__", "function") in ("module", "session"):
                if nome not in cache:
                    valor, gen = _abrir_fixture(f)
                    cache[nome] = valor
                    cache[f"__gen__{nome}"] = gen
                kwargs[nome] = cache[nome]
            else:
                valor, gen = _abrir_fixture(f)
                kwargs[nome] = valor
                teardowns.append(gen)
        else:
            raise AssertionError(f"parâmetro sem fixture: {nome!r}")

    try:
        func(**kwargs)
    finally:
        for inst in desfazer:
            if hasattr(inst, "undo"):
                inst.undo()
        for gen in reversed(teardowns):
            _fechar_fixture(gen)


def rodar(arquivos: list[Path], verboso: bool) -> tuple[int, int, int]:
    passou = falhou = pulou = 0
    falhas: list[tuple[str, str]] = []

    for arq in arquivos:
        print(f"\n{CINZA}── {arq.name}{RESET}")
        try:
            mod = _carregar(arq)
        except Exception:
            print(f"{VERMELHO}  ✖ falha ao importar{RESET}")
            falhas.append((arq.name, traceback.format_exc()))
            falhou += 1
            continue

        fixtures = _resolver_fixtures(mod)
        cache: dict[str, Any] = {}
        testes = [(n, o) for n, o in vars(mod).items()
                  if n.startswith("test_") and callable(o)]

        for nome, func in testes:
            casos: list[tuple[str, dict[str, Any]]] = [("", {})]
            if params := getattr(func, "__parametrize__", None):
                nomes, valores = params
                chaves = [c.strip() for c in nomes.split(",")] \
                    if isinstance(nomes, str) else list(nomes)
                casos = []
                for v in valores:
                    tupla = v if isinstance(v, (tuple, list)) else (v,)
                    casos.append((f"[{'-'.join(map(str, tupla))[:40]}]",
                                  dict(zip(chaves, tupla))))

            for sufixo, extra in casos:
                rotulo = f"{nome}{sufixo}"
                if motivo := getattr(func, "__skip__", None):
                    pulou += 1
                    if verboso:
                        print(f"{AMARELO}  ○ {rotulo} - {motivo}{RESET}")
                    continue
                try:
                    _chamar(func, fixtures, cache, extra)
                    passou += 1
                    if verboso:
                        print(f"{VERDE}  ✔ {rotulo}{RESET}")
                except _Pulado as e:
                    pulou += 1
                    if verboso:
                        print(f"{AMARELO}  ○ {rotulo} - {e}{RESET}")
                except Exception:
                    falhou += 1
                    print(f"{VERMELHO}  ✖ {rotulo}{RESET}")
                    falhas.append((rotulo, traceback.format_exc()))

        if not verboso:
            print(f"  {len(testes)} teste(s)")

    if falhas:
        print(f"\n{VERMELHO}{'=' * 70}\nFALHAS\n{'=' * 70}{RESET}")
        for rotulo, tb in falhas:
            print(f"\n{VERMELHO}✖ {rotulo}{RESET}\n{tb}")

    return passou, falhou, pulou


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    verboso = any(a in ("-v", "--verbose") for a in sys.argv[1:])
    filtro = args[0] if args else ""

    testes = sorted((RAIZ / "tests").glob("test_*.py"))
    if filtro:
        testes = [t for t in testes if filtro in t.name]
    if not testes:
        print(f"nenhum teste encontrado (filtro: {filtro!r})")
        return 1

    print(f"pytest real: {'sim' if TEM_PYTEST_REAL else 'NÃO - usando shim stdlib'}")
    passou, falhou, pulou = rodar(testes, verboso)

    print(f"\n{'=' * 70}")
    cor = VERMELHO if falhou else VERDE
    print(f"{cor}{passou} passaram · {falhou} falharam · {pulou} pulados{RESET}")
    return 1 if falhou else 0


if __name__ == "__main__":
    sys.exit(main())
