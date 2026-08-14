"""
Admissibilidade e segurança do arquivo enviado - TUDO antes de qualquer LLM.

Este módulo é a primeira barreira do sistema, e a mais barata: custa ZERO token.
São cinco camadas, em ordem de execução:

  0. o arquivo é o que diz ser?      (magic bytes, tamanho, páginas)
  1. o PDF tem conteúdo ativo?       (/JS, /OpenAction, /Launch, anexos)
  2. é uma demonstração financeira?  (evidência estrutural e ARITMÉTICA)
  3. o texto tem tentativa de injeção? (neutraliza e REGISTRA)
  4. (fora daqui) saída do LLM restrita por JSON Schema + guardrails

A camada 2 é a resposta direta ao requisito "se alguém subir uma receita de bolo,
o sistema deve entender que não é um demonstrativo e não seguir". Ela não depende
de semântica nem de modelo: exige EVIDÊNCIA ARITMÉTICA - ao menos uma linha cujo
valor seja a soma exata das linhas anteriores. Para passar, um atacante teria de
fabricar uma tabela numérica aritmeticamente consistente, ou seja, um balanço de
verdade. Receita, contrato, currículo: score zero, e o modelo nunca é chamado.
"""
from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "40"))

# 400 e não 120. O primeiro valor foi calibrado contra ITR trimestral (~50
# páginas) e recusava o caso MAJORITÁRIO: o DFP anual de companhia aberta tem
# rotineiramente 130 a 300 páginas - o DFP 2025 do Fleury tem 139 e era recusado.
#
# O limite existe para barrar arquivo absurdo antes de gastar CPU na extração de
# palavras, e esse objetivo continua atendido: 400 páginas ainda é uma fração do
# que `MAX_UPLOAD_MB = 40` permitiria, e o custo já é contido por
# `MAX_JOBS_SIMULTANEOS = 4` e pelo teto de 10 min de acompanhamento do job
# (`TETO_LEITURA_MS` no portal).
#
# Página excedente não polui o resultado: o gate de página mais o gate de
# demonstração já reduziram 50 páginas a 3 no ITR. O custo de páginas a mais é
# tempo, não erro - e recusar o documento inteiro transfere ao analista a tarefa
# de adivinhar quais páginas importam, que é exatamente o que a ferramenta faz
# melhor que ele.
MAX_PAGINAS = int(os.getenv("MAX_PAGINAS", "400"))

# Acima disto a leitura é aceita mas avisada: o usuário merece saber que vai
# esperar, em vez de achar que travou.
PAGINAS_PARA_AVISAR = 60

# ---------------------------------------------------------------------------
# Camada 0 - o arquivo é o que diz ser?
# ---------------------------------------------------------------------------
# A v1 confiava na EXTENSÃO do nome do arquivo (`MIME_BY_EXT.get(ext)`), o que é
# um buraco real: basta renomear qualquer coisa para `.pdf`. Aqui o tipo vem dos
# MAGIC BYTES do conteúdo.
ASSINATURAS: tuple[tuple[bytes, str], ...] = (
    (b"%PDF-", "application/pdf"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"PK\x03\x04", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
)
TIPOS_ACEITOS = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def detectar_tipo(dados: bytes) -> str | None:
    """Tipo real pelo conteúdo. `None` = formato não reconhecido."""
    for assinatura, mime in ASSINATURAS:
        if dados.startswith(assinatura):
            # WEBP é um contêiner RIFF, não casa por prefixo simples
            return mime
    if dados[:4] == b"RIFF" and dados[8:12] == b"WEBP":
        return "image/webp"
    return None


# ---------------------------------------------------------------------------
# Camada 1 - conteúdo ativo em PDF
# ---------------------------------------------------------------------------
# PDF é um formato executável: pode conter JavaScript, ação automática de
# abertura, lançamento de arquivo externo e anexos embutidos. Aceitar upload de
# terceiros sem checar isso é irresponsável, mesmo que a gente só leia texto.
MARCADORES_ATIVOS: tuple[tuple[bytes, str], ...] = (
    (b"/JavaScript", "JavaScript embutido"),
    (b"/JS", "ação JavaScript"),
    (b"/OpenAction", "ação automática na abertura"),
    (b"/AA", "ação adicional (evento)"),
    (b"/Launch", "lançamento de programa externo"),
    (b"/EmbeddedFile", "arquivo embutido"),
    (b"/RichMedia", "mídia interativa"),
    (b"/SubmitForm", "envio de formulário para URL"),
)


def detectar_conteudo_ativo(dados: bytes) -> list[str]:
    """Marcadores de conteúdo ativo encontrados. Vazio = limpo."""
    return [descricao for marcador, descricao in MARCADORES_ATIVOS if marcador in dados]


# ---------------------------------------------------------------------------
# Camada 3 - tentativa de injeção no texto do documento
# ---------------------------------------------------------------------------
# Estes padrões são reaproveitados de app/llm/guardrails.py de propósito: o mesmo
# conjunto vale para o texto do documento e para a resposta do modelo. Encontrar
# um padrão é SINAL DE SEGURANÇA - registramos, nunca silenciamos.
PADROES_INJECAO: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE) for p in (
        r"ignore\s+(as\s+|the\s+)?(instru|previous|above)",
        r"desconsidere\s+as\s+instru",
        r"disregard",
        r"you\s+are\s+now",
        r"novas\s+instru",
        r"prompt\s+anterior",
        r"system\s*:",
        r"assistant\s*:",
        r"<\|.*?\|>",
        r"```",
    )
)


def detectar_injecao(texto: str) -> list[str]:
    """Trechos suspeitos de injeção de prompt encontrados no texto."""
    achados: list[str] = []
    for padrao in PADROES_INJECAO:
        for m in padrao.finditer(texto or ""):
            achados.append(m.group(0)[:60])
    return achados


# ---------------------------------------------------------------------------
# Resultado
# ---------------------------------------------------------------------------
@dataclass
class Veredito:
    """Decisão sobre o arquivo, com o motivo legível para o usuário."""

    admissivel: bool
    tipo: str | None
    motivo: str = ""
    avisos: list[str] = field(default_factory=list)
    conteudo_ativo: list[str] = field(default_factory=list)
    tamanho_mb: float = 0.0

    def como_dict(self) -> dict:
        return {
            "admissivel": self.admissivel,
            "tipo": self.tipo,
            "motivo": self.motivo,
            "avisos": self.avisos,
            "conteudoAtivo": self.conteudo_ativo,
            "tamanhoMb": round(self.tamanho_mb, 2),
        }


_RE_CONTA_PAGINAS = re.compile(rb"/Type\s*/Page[^s]")


def contar_paginas_pdf(dados: bytes) -> int:
    """Nº de páginas por contagem de objetos `/Type /Page`, sem abrir o PDF.

    É aproximado de propósito: o objetivo aqui é BARRAR um arquivo absurdo antes
    de gastar CPU, não catalogar o documento. Usar uma lib de PDF para isso
    inverteria a ordem - a checagem de limite tem de ser mais barata que o
    trabalho que ela evita. A contagem exata sai depois, em `pdf_words.n_paginas`.

    `[^s]` no fim evita casar `/Type /Pages`, que é o nó da árvore, não a página.
    """
    return len(_RE_CONTA_PAGINAS.findall(dados))


def avaliar_arquivo(dados: bytes, nome: str = "") -> Veredito:
    """Camadas 0 e 1. Não olha conteúdo contábil - isso é do page_classifier."""
    tamanho_mb = len(dados) / (1024 * 1024)

    if not dados:
        return Veredito(False, None, "Arquivo vazio.", tamanho_mb=0.0)

    if tamanho_mb > MAX_UPLOAD_MB:
        return Veredito(False, None,
                        f"Arquivo de {tamanho_mb:.1f} MB acima do limite de "
                        f"{MAX_UPLOAD_MB} MB.", tamanho_mb=tamanho_mb)

    tipo = detectar_tipo(dados)
    if tipo is None:
        return Veredito(False, None,
                        "Não reconheci o formato pelo conteúdo do arquivo. "
                        "Aceito PDF, PNG, JPG, WEBP e XLSX.",
                        tamanho_mb=tamanho_mb)
    if tipo not in TIPOS_ACEITOS:
        return Veredito(False, tipo, f"Formato {tipo} não é aceito.",
                        tamanho_mb=tamanho_mb)

    # divergência entre extensão e conteúdo real: não bloqueia, mas registra
    avisos: list[str] = []
    ext = (nome or "").rsplit(".", 1)[-1].lower() if "." in (nome or "") else ""
    esperado_por_ext = {
        "pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg",
        "jpeg": "image/jpeg", "webp": "image/webp",
        "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsm": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }.get(ext)
    if esperado_por_ext and esperado_por_ext != tipo:
        avisos.append(
            f'a extensão ".{ext}" não corresponde ao conteúdo ({tipo}) - '
            "segui pelo conteúdo")
        logger.warning("extensão divergente do conteúdo: %s vs %s", ext, tipo)

    ativos: list[str] = []
    if tipo == "application/pdf":
        # Um PDF de mil páginas cabe folgado em 40 MB e consumiria minutos de CPU
        # na extração de palavras. O limite de tamanho sozinho não protege.
        paginas = contar_paginas_pdf(dados)
        if paginas > MAX_PAGINAS:
            return Veredito(
                False, tipo,
                f"PDF com {paginas} páginas, acima do limite de {MAX_PAGINAS}. "
                "O limite protege a CPU da extração de palavras, não a leitura: "
                "as páginas que não são demonstração já são descartadas pelo "
                "gate. Se este documento é legítimo, suba MAX_PAGINAS no "
                "servidor - ou envie o intervalo que contém o Balanço e a DRE.",
                avisos=avisos, tamanho_mb=tamanho_mb)
        if paginas:
            avisos.append(f"{paginas} página(s) detectada(s)")
        if paginas > PAGINAS_PARA_AVISAR:
            # Sem este aviso, uma leitura de 139 páginas parece travamento.
            avisos.append(
                f"{paginas} páginas é um relatório anual completo - a extração "
                "de palavras leva mais tempo. O gate descarta o que não é "
                "demonstração, então o resultado não fica mais sujo, só demora.")

        ativos = detectar_conteudo_ativo(dados)
        if ativos:
            # Recusa. Não precisamos de nada disso para ler uma demonstração, e
            # aceitar seria carregar risco sem contrapartida.
            logger.warning("PDF com conteúdo ativo recusado: %s", ativos)
            return Veredito(
                False, tipo,
                "Este PDF contém conteúdo ativo (" + ", ".join(ativos)
                + "), que não é necessário para uma demonstração financeira e "
                "por isso não é aceito. Reexporte o arquivo como PDF simples "
                "(imprimir para PDF resolve).",
                avisos=avisos, conteudo_ativo=ativos, tamanho_mb=tamanho_mb)

    return Veredito(True, tipo, "", avisos=avisos, tamanho_mb=tamanho_mb)
