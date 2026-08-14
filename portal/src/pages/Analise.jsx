// A ANÁLISE - quatro etapas: Documento, Conferência, Revisão, Resultado.
//
// ---------------------------------------------------------------------------
// A DECISÃO DE ARQUITETURA DESTA PÁGINA
// ---------------------------------------------------------------------------
// O RESULTADO DO PIPELINE NUNCA É ESTADO. Ele é derivado por `useMemo` sobre as
// linhas, exatamente como no teste:
//
//   runPipeline(linhas, { dicionario, companyMemory, saldosAbsolutos, transportarResultado })
//
// Guardar o resultado em `useState` significaria ter duas fontes de verdade - as
// linhas e o resultado - e a segunda ficando velha a cada edição que esquecesse
// de atualizá-la. Num sistema em que o número na tela é `Ativo = Passivo + PL`,
// um resultado velho é pior que nenhum resultado. Derivar custa um recálculo por
// tecla (~358 linhas, alguns milissegundos) e elimina a classe inteira de bugs
// de sincronização.
//
// Consequência: para "editar" qualquer coisa, mexemos nas LINHAS DE ENTRADA. É
// também por isso que ajuste é MUTAÇÃO DA LINHA e não lançamento de ajuste: as
// colunas Retirar/Adicionar do template Excel permitiam somar valor a uma linha
// sem tirá-lo de outra, violando a conservação por construção.
//
// ---------------------------------------------------------------------------
// POR QUE CSV E TABELA COLADA NÃO PASSAM PELA API
// ---------------------------------------------------------------------------
// A camada 0 de segurança do servidor identifica o tipo por MAGIC BYTES e aceita
// PDF, PNG, JPG, WEBP e XLSX - CSV não tem assinatura e seria recusado, com
// razão. Como CSV e texto colado já são tabela, parseá-los no navegador é
// determinístico, instantâneo e não gasta rede. O caminho da API existe para o
// que exige extração: PDF, imagem e planilha binária.

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { runPipeline } from '../core/index.js';
import { candidatosPara } from '../core/planoContas.js';
import { pendentesDeJulgamento, patchesResiduais } from '../core/matching.js';
import { parseNumber } from '../core/normalize.js';
import { naturezaEsperada, NATUREZA } from '../core/sign.js';
import {
  SLOTS, aplicarSelecao, chavesDeSelecao, descartadasDe, escolhaPadrao,
} from '../core/demonstracoes.js';
import { useApp } from '../context/AppContext.jsx';
import { tabelaParaLinhas } from '../lib/tabela.js';
import { ErroApi, Cancelado, lerDocumento, julgamental, parecer } from '../lib/api.js';
import {
  carregarMemoria, listarClientes, listarDicionario, obterAnalise,
  salvarAnalise, salvarMemoria,
} from '../lib/repo.js';
import { moeda, inteiro, anosComDados, tamanhoArquivo, percentual } from '../lib/formato.js';
import TrilhaDeValor from '../components/TrilhaDeValor.jsx';
import PainelQA from '../components/PainelQA.jsx';
import ShadowView from '../components/ShadowView.jsx';
import GradeRastreabilidade from '../components/GradeRastreabilidade.jsx';
import DiffMemoria from '../components/DiffMemoria.jsx';

const ETAPAS = [
  { n: 1, chave: 'documento', rotulo: 'Documento' },
  { n: 2, chave: 'conferencia', rotulo: 'Conferência' },
  { n: 3, chave: 'revisao', rotulo: 'Revisão' },
  { n: 4, chave: 'resultado', rotulo: 'Resultado' },
];

const EXTENSOES_API = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.xlsx'];
const EXTENSOES_LOCAIS = ['.csv', '.txt', '.tsv'];

let seqId = 0;
const novoIdLinha = () => { seqId += 1; return `L${seqId}`; };

// O PARSER DE TABELA VIVE EM `lib/tabela.js`, e não aqui: é transformação de
// dado, não interface. Num arquivo `.jsx` ele seria intestável em `node:test` (o
// Node não parseia JSX), e um parser de documento contábil sem teste é
// exatamente o código que desloca uma coluna em silêncio e produz um balanço
// errado sem ninguém saber.

// ---------------------------------------------------------------------------
// Etapa 1 - DOCUMENTO
// ---------------------------------------------------------------------------
function EtapaDocumento({
  aoCarregar, apiInferencia,
}) {
  const [sobre, setSobre] = useState(false);
  const [progresso, setProgresso] = useState(null);
  const [erroLeitura, setErroLeitura] = useState(null);
  const [colado, setColado] = useState('');
  const abortRef = useRef(null);
  const inputRef = useRef(null);

  const enviarArquivo = useCallback(async (arquivo) => {
    setErroLeitura(null);
    const nome = (arquivo.name || '').toLowerCase();

    // CSV / texto: parse local, determinístico, sem rede.
    if (EXTENSOES_LOCAIS.some((e) => nome.endsWith(e))) {
      const texto = await arquivo.text();
      const { linhas, periodos, avisos } = tabelaParaLinhas(texto);
      if (!linhas.length) {
        setErroLeitura({
          titulo: 'Não consegui interpretar o arquivo como tabela.',
          detalhe: avisos.join(' '),
          gate: false,
        });
        return;
      }
      aoCarregar({
        fonte: 'colado',
        arquivo: { nome: arquivo.name, tamanho: arquivo.size },
        linhas,
        periodos,
        avisos,
        saldosAbsolutos: false,
      });
      return;
    }

    if (!EXTENSOES_API.some((e) => nome.endsWith(e))) {
      setErroLeitura({
        titulo: `Não sei ler "${arquivo.name}".`,
        detalhe: `Aceito ${EXTENSOES_API.join(', ')} pela API e ${EXTENSOES_LOCAIS.join(', ')} `
          + 'direto no navegador. Se for uma tabela, cole o conteúdo no campo abaixo.',
        gate: false,
      });
      return;
    }

    if (!apiInferencia) {
      setErroLeitura({
        titulo: 'Ler PDF, imagem e XLSX exige o plano de inferência.',
        detalhe: 'Nenhuma URL de inferência está configurada. Preencha em Configurações, ou '
          + 'cole a tabela / digite as linhas à mão - o pipeline contábil e o fechamento '
          + 'funcionam igual sem servidor.',
        gate: false,
      });
      return;
    }

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgresso({ fase: 'enviando', mensagem: 'enviando…', decorridoMs: 0 });
    try {
      const res = await lerDocumento(arquivo, setProgresso, { sinal: ctrl.signal });
      aoCarregar({
        ...res,
        arquivo: { ...(res.arquivo ?? {}), nome: arquivo.name, tamanho: arquivo.size },
        linhas: (res.linhas ?? []).map((l) => ({ ...l, id: novoIdLinha() })),
      });
    } catch (e) {
      if (e instanceof Cancelado) {
        setErroLeitura({
          titulo: 'Leitura cancelada.',
          detalhe: 'Nada foi carregado. Pode reenviar quando quiser.',
          gate: false,
        });
        return;
      }
      const gate = e instanceof ErroApi && e.status === 422;
      setErroLeitura({
        titulo: gate
          ? 'O gate contábil recusou este documento.'
          : (e?.message || 'A leitura falhou.'),
        detalhe: gate ? e.message : (e?.dica || ''),
        gate,
      });
    } finally {
      setProgresso(null);
      abortRef.current = null;
    }
  }, [aoCarregar, apiInferencia]);

  const usarColado = () => {
    setErroLeitura(null);
    const { linhas, periodos, avisos } = tabelaParaLinhas(colado);
    if (!linhas.length) {
      setErroLeitura({
        titulo: 'Não consegui interpretar o texto colado.',
        detalhe: avisos.join(' '),
        gate: false,
      });
      return;
    }
    aoCarregar({
      fonte: 'colado',
      arquivo: { nome: '(colado)', tamanho: colado.length },
      linhas,
      periodos,
      avisos,
      saldosAbsolutos: false,
    });
  };

  const comecarVazio = () => {
    aoCarregar({
      fonte: 'manual',
      arquivo: { nome: '(digitado)', tamanho: 0 },
      linhas: Array.from({ length: 5 }, () => ({
        id: novoIdLinha(), origem: '', codigo: '', valoresPorSlot: {}, naturezaPorSlot: {},
      })),
      periodos: [],
      avisos: ['Linhas em branco: digite origem, código e valor. Sem código nem hierarquia, '
        + 'toda linha é tratada como analítica.'],
      saldosAbsolutos: false,
    });
  };

  return (
    <>
      <section className="painel">
        <div className="painel-cabecalho">
          <div>
            <h2>1. Documento</h2>
            <div className="fraco">
              A leitura é determinística e custa zero token: o modelo não vê números, não
              decide colunas e não decide hierarquia. Ele só é chamado depois, para julgar
              nomes de conta que o dicionário não conhece.
            </div>
          </div>
        </div>
        <div className="painel-corpo">
          <div
            className={`dropzone${sobre ? ' sobre' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setSobre(true); }}
            onDragLeave={() => setSobre(false)}
            onDrop={(e) => {
              e.preventDefault();
              setSobre(false);
              const f = e.dataTransfer?.files?.[0];
              if (f) enviarArquivo(f);
            }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
          >
            <strong>Arraste o arquivo aqui ou clique para selecionar</strong>
            PDF, PNG, JPG, WEBP, XLSX (lidos pela API) · CSV, TSV, TXT (lidos no navegador)
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.xlsx,.csv,.tsv,.txt"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) enviarArquivo(f);
                e.target.value = '';
              }}
            />
          </div>

          {progresso ? (
            <div className="aviso info" style={{ marginTop: 12 }}>
              <div className="linha-botoes">
                <div style={{ flex: '1 1 auto' }}>
                  <div className="aviso-titulo">
                    <span className="girando" /> {progresso.mensagem}
                  </div>
                  <div className="aviso-dica">
                    {Math.round((progresso.decorridoMs ?? 0) / 1000)}s
                    {progresso.tentativas ? ` · ${progresso.tentativas} consulta(s)` : ''}
                    {progresso.falhasSeguidas
                      ? ` · ${progresso.falhasSeguidas} falha(s) de rede - continuo acompanhando`
                      : ''}
                    {' · teto de 10 minutos'}
                  </div>
                </div>
                <button type="button" onClick={() => abortRef.current?.abort()}>cancelar</button>
              </div>
              {/* A barra mede o TEMPO DECORRIDO contra o teto de 10 minutos, não o
                  avanço do job. O servidor manda texto ("extraindo página 7…") e
                  não percentual; desenhar uma barra de progresso falsa seria pior
                  que não desenhar nenhuma. O que ela informa é honesto e útil:
                  quanto falta para o portal desistir. */}
              <div className="progresso-trilho" style={{ marginTop: 8 }}>
                <div
                  className="progresso-barra"
                  style={{
                    width: `${Math.min(100, ((progresso.decorridoMs ?? 0) / (10 * 60 * 1000)) * 100)}%`,
                  }}
                />
              </div>
            </div>
          ) : null}

          {erroLeitura ? (
            <div
              className={`aviso ${erroLeitura.gate ? 'erro destaque' : 'erro'}`}
              style={{ marginTop: 12 }}
              role="alert"
            >
              <div className="aviso-titulo">{erroLeitura.titulo}</div>
              {erroLeitura.detalhe ? <p>{erroLeitura.detalhe}</p> : null}
              {erroLeitura.gate ? (
                <div className="aviso-dica">
                  <strong>Nenhum token foi gasto.</strong> A recusa acontece antes de qualquer
                  chamada de modelo: a verificação é estrutural e aritmética - exige uma linha
                  cujo valor seja a soma exata das anteriores, em todas as colunas. Um texto
                  que só cite &quot;Total do Ativo&quot; não passa. Envie a página que contém o
                  Balanço Patrimonial ou a DRE (DFC, DMPL, DVA e notas explicativas são
                  recusadas de propósito) - ou cole a tabela abaixo.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="painel">
        <div className="painel-cabecalho">
          <div>
            <h2>Ou cole a tabela</h2>
            <div className="fraco">
              Copie do Excel ou do PDF e cole aqui. As colunas são detectadas por estrutura
              (quais têm números, qual tem código, qual tem D/C), não por nome de cabeçalho.
            </div>
          </div>
        </div>
        <div className="painel-corpo">
          <textarea
            value={colado}
            onChange={(e) => setColado(e.target.value)}
            placeholder={'Código\tDescrição\t31/05/2026\tD/C\n11010100000071\tCAIXA GERAL\t12.345,67\tD'}
            spellCheck={false}
          />
          <div className="linha-botoes" style={{ marginTop: 8 }}>
            <button type="button" className="primario" onClick={usarColado} disabled={!colado.trim()}>
              interpretar tabela
            </button>
            <button type="button" onClick={comecarVazio}>começar em branco (digitar à mão)</button>
          </div>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Etapa 2 - CONFERÊNCIA
// ---------------------------------------------------------------------------
/**
 * Escolha da demonstração e mapeamento COLUNA -> SLOT.
 *
 * Este painel é a correção de um defeito de produto, não de cálculo: a ferramenta
 * escolhia sozinha qual coluna virava Ano 3 (`computeYears` pegava "as 3 mais
 * recentes" entre TODOS os rótulos) e, num ITR com 38 pseudo-períodos, escolheu
 * `coluna 7 · coluna 8 · coluna 9` - fragmentos de tabela de nota. O Ativo saiu
 * R$ 2,00 e nada na tela dizia que uma escolha havia sido feita.
 *
 * Qual coluna entra na análise é julgamento profissional: pode ser Controladora
 * ou Consolidado, trimestre ou acumulado, Saldo Final ou Débito/Crédito. A
 * ferramenta PROPÕE com critério explícito; quem decide é o analista.
 *
 * O que torna a escolha possível mesmo com rótulo torto é a coluna
 * "produz", que mostra o valor daquela coluna na linha que FECHA a demonstração:
 * 13,56 bi contra 11,69 bi identifica Consolidado x Controladora num olhar.
 */
function SelecaoDemonstracao({
  demonstracoes, escolha, mapeamento, aoTrocarEscolha, aoTrocarMapeamento, emUso,
}) {
  // Agrupado pelo LADO que a página fecha, não por "BP". Na DFP padronizada da
  // CVM o Ativo e o Passivo vêm em páginas separadas: um card só para "Balanço"
  // faria o analista escolher uma das duas e perder a outra - foi o que produziu
  // 48 linhas sem nenhum Passivo. Uma página que fecha os dois lados aparece nos
  // dois cards.
  const porFamilia = new Map();
  for (const d of demonstracoes) {
    for (const chave of chavesDeSelecao(d)) {
      if (!porFamilia.has(chave)) porFamilia.set(chave, []);
      porFamilia.get(chave).push(d);
    }
  }

  const rotuloFamilia = (f) => ({
    'BP-ATIVO': 'Balanço - Ativo',
    'BP-PASSIVO': 'Balanço - Passivo e Patrimônio Líquido',
    DRE: 'DRE',
  }[f] ?? f);

  return (
    <div style={{ marginTop: 14 }}>
      <h4>O que planilhar</h4>
      <div className="fraco" style={{ marginBottom: 8 }}>
        Uma demonstração por família e uma coluna por Ano. Em uso:{' '}
        {emUso.join(' · ') || ' - '}.
      </div>

      {[...porFamilia.entries()].map(([familia, opcoes]) => {
        const escolhida = opcoes.find((d) => d.id === escolha[familia]);
        return (
          <div className="cartao" key={familia} style={{ marginBottom: 10 }}>
            <div className="rotulo">{rotuloFamilia(familia)}</div>

            {opcoes.length > 1 ? (
              <div className="chips" style={{ margin: '6px 0' }}>
                {opcoes.map((d) => (
                  <label className="badge" key={d.id} style={{ cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name={`demo-${familia}`}
                      checked={escolha[familia] === d.id}
                      onChange={() => aoTrocarEscolha(familia, d.id)}
                    />
                    {' '}pág. {d.pagina}
                    {d.colunas?.[0]?.escopo ? ` · ${d.colunas[0].escopo}` : ''}
                  </label>
                ))}
                <label className="badge" style={{ cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name={`demo-${familia}`}
                    checked={!escolha[familia]}
                    onChange={() => aoTrocarEscolha(familia, null)}
                  />
                  {' '}não usar
                </label>
              </div>
            ) : (
              <div className="nota">
                página {opcoes[0].pagina}
                {opcoes[0].escala?.unidade ? ` · em ${opcoes[0].escala.unidade}` : ''}
              </div>
            )}

            {escolhida?.mapeamento?.escolhaPendente ? (
              <div className="aviso atencao" style={{ margin: '6px 0' }}>
                <div className="aviso-titulo">Confirme a coluna</div>
                <div className="aviso-dica">
                  {escolhida.mapeamento.motivoPendencia
                    || 'Há mais de uma coluna possível para o mesmo período.'}
                  {escolhida.mapeamento.criterio
                    ? ` Proposta automática: ${escolhida.mapeamento.criterio}.`
                    : ''}
                </div>
              </div>
            ) : null}

            {escolhida ? (
              <div className="tabela-envelope" style={{ maxHeight: 260 }}>
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Coluna do documento</th>
                      <th>Escopo</th>
                      <th>Período</th>
                      <th className="num">Produz</th>
                      <th>Usar como</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(escolhida.colunas ?? []).map((c) => {
                      // O mapa do analista, quando existe, vale INTEIRO: ele já
                      // nasce mesclado com a proposta em `trocarMapeamento`.
                      // Usar `??` slot a slot faria um `null` explícito ("não
                      // usar") cair de volta na proposta, e a coluna continuaria
                      // parecendo atribuída depois de o usuário tê-la liberado.
                      const mapa = mapeamento[escolhida.id]
                        ?? escolhida.mapeamento?.porSlot ?? {};
                      const atual = SLOTS.find((s) => mapa[s] === c.rotulo) ?? '';
                      const referencia = Object.entries(c.valoresDeReferencia ?? {});
                      return (
                        <tr key={c.rotulo}>
                          <td>{c.rotulo}</td>
                          <td>{c.escopo || <span className="fraco"> - </span>}</td>
                          <td>{c.recorte || <span className="fraco"> - </span>}</td>
                          <td className="num" title={referencia.map(([k]) => k).join(' · ')}>
                            {referencia.length
                              ? moeda(referencia[0][1])
                              : <span className="fraco"> - </span>}
                          </td>
                          <td>
                            <select
                              value={atual}
                              onChange={(e) => aoTrocarMapeamento(
                                escolhida.id, c.rotulo, e.target.value || null,
                              )}
                            >
                              <option value="">não usar</option>
                              {SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function EtapaConferencia({
  leitura, saldosAbsolutos, aoTrocarSaldosAbsolutos, result, aoConfirmar, aoVoltar,
  escolha, mapeamento, aoTrocarEscolha, aoTrocarMapeamento,
}) {
  const paginas = leitura?.paginas ?? [];
  const evidencias = leitura?.evidencias ?? [];
  const avisos = leitura?.avisos ?? [];
  const verificacao = result?.diagnostico?.verificacaoLeitura;
  const hier = result?.diagnostico?.hierarquia;
  const demonstracoes = leitura?.demonstracoes ?? [];
  const paginasIgnoradas = leitura?.paginasIgnoradas ?? [];
  const descartadas = useMemo(
    () => descartadasDe(demonstracoes, escolha), [demonstracoes, escolha],
  );

  return (
    <section className="painel">
      <div className="painel-cabecalho">
        <div>
          <h2>2. Conferência da leitura</h2>
          <div className="fraco">
            Antes de alocar, confirme que o documento foi LIDO certo. Erro de leitura fica
            localizado num bloco e não faz sentido investigar alocação enquanto ele existe.
          </div>
        </div>
        <div className="linha-botoes">
          <button type="button" onClick={aoVoltar}>voltar</button>
          <button type="button" className="primario" onClick={aoConfirmar}>
            confere, ir para a revisão
          </button>
        </div>
      </div>

      <div className="painel-corpo">
        <div className="grade-cartoes">
          <div className="cartao">
            <div className="rotulo">Fonte</div>
            <div className="valor" style={{ fontSize: 17 }}>{leitura?.fonte ?? ' - '}</div>
            <div className="nota">
              {leitura?.arquivo?.nome}
              {leitura?.arquivo?.tamanho
                ? ` · ${tamanhoArquivo(leitura.arquivo.tamanho)}`
                : ''}
            </div>
          </div>
          <div className="cartao">
            <div className="rotulo">Linhas lidas</div>
            <div className="valor">{inteiro(leitura?.linhas?.length ?? 0)}</div>
            <div className="nota">
              {hier ? `${hier.folhas} folhas · ${hier.sinteticas} sintéticas` : ' - '}
            </div>
          </div>
          <div className="cartao">
            <div className="rotulo">Hierarquia por</div>
            <div className="valor" style={{ fontSize: 17 }}>{hier?.fonte ?? ' - '}</div>
            <div className="nota">
              {hier?.fonte === 'codigo'
                ? 'código contábil: maior prefixo estrito presente'
                : hier?.fonte === 'hierarquia'
                  ? 'campo Hierarquia (nome do pai)'
                  : 'nenhuma: TODA linha vira analítica'}
            </div>
          </div>
          <div className="cartao">
            <div className="rotulo">Verificação de leitura</div>
            {/*
              "passou" com ZERO assertivas é verde por vacuidade: sem hierarquia
              não existe sintética para conferir, então o teste não tem o que
              fazer e passa. Verde por ausência de teste é pior que vermelho,
              faz confiar na hora errada. Aqui isso vira "não verificável".
            */}
            <div
              className={`valor ${!verificacao || !verificacao.testes
                ? 'valor-atencao' : verificacao.ok ? 'valor-ok' : 'valor-erro'}`}
              style={{ fontSize: 17 }}
            >
              {!verificacao ? ' - '
                : !verificacao.testes ? 'não verificável'
                  : verificacao.ok ? 'passou'
                    : `${verificacao.divergencias.length} blocos`}
            </div>
            <div className="nota">
              {!verificacao ? ' - '
                : !verificacao.testes
                  ? 'nenhuma sintética para conferir: a leitura não foi testada'
                  : `${verificacao.testes} assertivas: sintética x soma das folhas`}
            </div>
          </div>
        </div>

        {verificacao && !verificacao.testes ? (
          <div className="aviso atencao">
            <div className="aviso-titulo">
              A verificação de leitura não testou nada.
            </div>
            <div className="aviso-dica">
              Ela compara cada conta sintética com a soma das suas folhas. Sem
              hierarquia reconhecida não há sintética, então não há o que comparar,
              e o documento pode estar sendo lido errado sem que nada acuse. Não
              trate isto como aprovação.
            </div>
          </div>
        ) : null}

        {hier?.fonte === 'nenhuma' ? (
          <div className="aviso erro">
            <div className="aviso-titulo">
              Sem código contábil e sem hierarquia: todas as {inteiro(leitura?.linhas?.length ?? 0)} linhas
              foram tratadas como analíticas.
            </div>
            <div className="aviso-dica">
              Se houver totalizadores entre elas, o valor deles será somado JUNTO com as
              aberturas e o balanço sairá multiplicado. Foi exatamente isso que inflou um
              Ativo de 118 MM para ~382 MM na v1. Marque os totalizadores como
              &quot;contexto&quot; na grade, ou preencha a coluna de código.
            </div>
          </div>
        ) : null}

        {verificacao && !verificacao.ok ? (
          <div className="aviso erro destaque">
            <div className="aviso-titulo">
              Erro de LEITURA em {verificacao.divergencias.length} bloco(s): a conta sintética
              não bate com a soma das suas folhas.
            </div>
            <div className="tabela-envelope" style={{ maxHeight: 220 }}>
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Bloco</th><th>Conta</th><th>Coluna</th>
                    <th className="num">Declarado</th>
                    <th className="num">Soma das folhas</th>
                    <th className="num">Diferença</th>
                  </tr>
                </thead>
                <tbody>
                  {verificacao.divergencias.slice(0, 15).map((d, i) => (
                    <tr key={`${d.codigo}-${d.coluna}-${i}`}>
                      <td className="mono">{d.codigo}</td>
                      <td>{d.origem}</td>
                      <td className="fraco">{d.coluna}</td>
                      <td className="num">{moeda(d.declarado)}</td>
                      <td className="num">{moeda(d.somaFolhas)}</td>
                      <td className="num valor-erro">{moeda(d.diferenca)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="aviso-dica">
              A causa mais comum é a natureza D/C não ter sido aplicada. Se o documento traz
              todos os valores positivos com uma coluna Débito/Crédito ao lado, marque
              &quot;saldos absolutos&quot; abaixo. A segunda causa é desalinhamento de coluna:
              confira os valores deste bloco contra o documento.
            </div>
          </div>
        ) : null}

        <label className="caixa-marcavel">
          <input
            type="checkbox"
            checked={saldosAbsolutos}
            onChange={(e) => aoTrocarSaldosAbsolutos(e.target.checked)}
          />
          <span>
            <strong>Balancete com saldos absolutos</strong> - os valores vêm todos positivos e
            a natureza está numa coluna D/C
            <div className="fraco">
              Típico de exportação de ERP (Protheus, SAP). Sem esta marcação, um saldo credor
              de conta de Ativo entra positivo e infla o Ativo: no caso real que motivou o
              projeto isso somava R$ 26,5 MM ao Ativo e R$ 124,6 MM ao Passivo. Com ela, o
              módulo é o dado e o D/C é o sinal.
            </div>
          </span>
        </label>

        {leitura?.saldosAbsolutos && !saldosAbsolutos ? (
          <div className="aviso atencao">
            A leitura detectou que este documento traz saldos absolutos, mas a opção está
            desmarcada. Marque-a, ou a natureza D/C será ignorada.
          </div>
        ) : null}

        {demonstracoes.length ? (
          <SelecaoDemonstracao
            demonstracoes={demonstracoes}
            escolha={escolha}
            mapeamento={mapeamento}
            aoTrocarEscolha={aoTrocarEscolha}
            aoTrocarMapeamento={aoTrocarMapeamento}
            emUso={result?.years ?? []}
          />
        ) : leitura?.periodos?.length ? (
          <div style={{ marginTop: 12 }}>
            <h4>Períodos detectados</h4>
            <div className="chips">
              {leitura.periodos.map((p) => <span className="badge" key={p}>{p}</span>)}
            </div>
            <div className="fraco" style={{ marginTop: 4 }}>
              O pipeline usa no máximo os 3 mais recentes, com o mais recente em Ano 3.
              Em uso: {(result?.years ?? []).join(' · ') || ' - '}.
            </div>
          </div>
        ) : null}

        {descartadas.length ? (
          <details style={{ marginTop: 14 }}>
            <summary>
              <strong>{inteiro(descartadas.length)} linha(s) descartada(s) na leitura</strong>
              {' '} - clique para conferir
            </summary>
            <div className="fraco" style={{ margin: '6px 0' }}>
              Estas linhas NÃO entram na alocação. Aparecem aqui porque descartar
              valor sem dizer que descartou é o mesmo defeito de perder linha por
              chave errada: o número muda e nada na tela explica.
            </div>
            <div className="tabela-envelope" style={{ maxHeight: 240 }}>
              <table className="tabela">
                <thead>
                  <tr><th>Pág.</th><th>Linha</th><th>Valores</th><th>Motivo</th></tr>
                </thead>
                <tbody>
                  {descartadas.map((d, i) => (
                    <tr key={`${d.demonstracao}-${i}`}>
                      <td>{d.pagina}</td>
                      <td>{d.origem}</td>
                      <td className="num">
                        {Object.values(d.valoresPorSlot ?? {})
                          .map((v) => moeda(v)).join(' · ') || ' - '}
                      </td>
                      <td className="fraco">{d.motivo}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}

        {paginasIgnoradas.length ? (
          <details style={{ marginTop: 10 }}>
            <summary>
              <strong>{inteiro(paginasIgnoradas.length)} página(s) deixada(s) de fora</strong>
              {' '} - nota explicativa, índice ou parecer
            </summary>
            <div className="fraco" style={{ margin: '6px 0' }}>
              Passaram no gate de página (têm âncora contábil, colunas alinhadas e
              subtotal que fecha), mas nenhuma FECHA uma demonstração: não têm
              linha de total do ativo, total do passivo nem lucro líquido. Uma nota
              decompõe uma linha do balanço; ela não fecha o balanço.
            </div>
            <div className="chips">
              {paginasIgnoradas.map((p) => (
                <span className="badge" key={p.pagina}>
                  pág. {p.pagina} · {p.tipo} · {p.score?.toFixed?.(2) ?? p.score}
                </span>
              ))}
            </div>
          </details>
        ) : null}

        {paginas.length ? (
          <div style={{ marginTop: 14 }}>
            <h4>Páginas classificadas (sem IA)</h4>
            <div className="tabela-envelope" style={{ maxHeight: 260 }}>
              <table className="tabela">
                <thead>
                  <tr>
                    <th className="num">Pág.</th><th>Tipo</th>
                    <th className="num">Score</th><th>Texto</th><th>Evidências</th>
                  </tr>
                </thead>
                <tbody>
                  {paginas.map((p) => (
                    <tr key={p.pagina}>
                      <td className="num">{p.pagina}</td>
                      <td>{p.tipo}</td>
                      <td className="num">{typeof p.score === 'number' ? p.score.toFixed(2) : ''}</td>
                      <td>
                        {p.temTexto
                          ? <span className="badge ok">sim</span>
                          : <span className="badge atencao">escaneada</span>}
                      </td>
                      <td className="fraco">{(p.evidencias ?? []).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="fraco" style={{ marginTop: 4 }}>
              O score exige evidência ARITMÉTICA: ao menos uma linha cujo valor seja a soma
              exata das anteriores em todas as colunas. É o que impede um documento que só
              cita termos contábeis de passar pelo gate.
            </div>
          </div>
        ) : null}

        {evidencias.length ? (
          <div style={{ marginTop: 12 }}>
            <h4>Evidências da leitura</h4>
            <ul className="lista-simples">
              {evidencias.slice(0, 12).map((e, i) => (
                <li key={i}>{typeof e === 'string' ? e : JSON.stringify(e)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {leitura?.paginasSemTexto?.length ? (
          <div className="aviso atencao" style={{ marginTop: 12 }}>
            <div className="aviso-titulo">
              Páginas {leitura.paginasSemTexto.join(', ')} não têm camada de texto.
            </div>
            <div className="aviso-dica">
              São escaneadas: a leitura por coordenada não funciona nelas e a extração exige o
              modelo de visão. Se essas páginas contêm parte do balanço, o total lido estará
              incompleto - e a verificação de leitura acima vai acusar.
            </div>
          </div>
        ) : null}

        {leitura?.injecoesNeutralizadas?.length ? (
          <div className="aviso atencao" style={{ marginTop: 12 }}>
            <div className="aviso-titulo">
              {leitura.injecoesNeutralizadas.length} trecho(s) com padrão de injeção de prompt
              foram neutralizados no texto do documento.
            </div>
            <div className="aviso-dica">
              O texto do documento é conteúdo NÃO CONFIÁVEL e trafega isolado do canal de
              instrução. Os valores nunca vêm do modelo: vêm do parser posicional.
            </div>
          </div>
        ) : null}

        {avisos.length ? (
          <div style={{ marginTop: 12 }}>
            <h4>Avisos da leitura</h4>
            <ul className="lista-simples">
              {avisos.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Etapa 4 - RESULTADO
// ---------------------------------------------------------------------------
function EtapaResultado({
  result, meta, aoTrocarMeta, clientes, salvando, aoSalvar, aoAbrirMemoria,
  apiInferencia, avisar,
}) {
  const [textoParecer, setTextoParecer] = useState('');
  const [gerando, setGerando] = useState(false);
  const anos = anosComDados(result?.yearHeaders);
  const ultimo = anos[anos.length - 1];
  const balance = ultimo ? result.shadow.balance[ultimo.campo] : null;

  const resumoParaParecer = useMemo(() => ({
    empresa: meta.empresa,
    periodos: result?.years ?? [],
    balanco: result?.shadow?.balance ?? null,
    totais: result?.shadow?.totals ?? null,
    trilha: {
      ok: result?.shadow?.trilha?.ok ?? false,
      perdas: result?.shadow?.trilha?.perdas ?? null,
    },
    qa: {
      bloqueado: result?.qa?.bloqueado ?? false,
      nBloqueantes: result?.qa?.summary?.nBloqueantes ?? 0,
      nAvisos: result?.qa?.summary?.nAvisos ?? 0,
    },
  }), [meta.empresa, result]);

  const gerarParecer = async () => {
    setGerando(true);
    try {
      const r = await parecer(resumoParaParecer);
      setTextoParecer(r.parecer || '');
      avisar('ok', `Parecer gerado por ${r.provedor}/${r.modelo}.`,
        'É texto executivo: revise antes de usar. O parecer nunca altera dado nenhum.');
    } catch (e) {
      avisar('erro', e?.message || 'Não consegui gerar o parecer.',
        e?.dica || 'Escreva o parecer à mão: ele é prosa e não afeta o cálculo.');
    } finally {
      setGerando(false);
    }
  };

  const baixar = (nome, conteudo, tipo) => {
    const blob = new Blob([conteudo], { type: tipo });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Exporta a Rastreabilidade em CSV com ponto-e-vírgula e BOM.
   *
   * Ponto-e-vírgula porque os valores usam vírgula decimal; BOM porque sem ele o
   * Excel em pt-BR abre UTF-8 como Latin-1 e todo acento vira lixo. Sem
   * biblioteca de XLSX de propósito: uma dependência de ~900 kB para gerar um
   * arquivo que o Excel abre igual não se paga.
   */
  const exportarCsv = () => {
    const cols = ['id', 'origem', 'codigo', 'hierarquiaDisplay', 'grupo', 'subCategoria',
      'destino', 'tipoMapeamento', 'alocacaoHierarquia', 'totalizador',
      'ano1', 'ano2', 'ano3', 'chave', 'chaveDestino'];
    const escapar = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const linhas = [cols.join(';')];
    for (const r of result.rows) linhas.push(cols.map((c) => escapar(r[c])).join(';'));
    baixar(`rastreabilidade-${meta.empresa || 'analise'}.csv`,
      `\uFEFF${linhas.join('\r\n')}`, 'text/csv;charset=utf-8');
  };

  const exportarJson = () => {
    baixar(`analise-${meta.empresa || 'sem-nome'}.json`, JSON.stringify({
      meta,
      periodos: result.years,
      shadow: {
        balance: result.shadow.balance,
        totals: result.shadow.totals,
        trilha: result.shadow.trilha,
        orphans: result.shadow.orphans,
      },
      qa: result.qa,
      rows: result.rows,
    }, null, 2), 'application/json');
  };

  return (
    <>
      <section className="painel">
        <div className="painel-cabecalho">
          <div>
            <h2>4. Resultado</h2>
            <div className="fraco">
              {result?.qa?.bloqueado
                ? 'Há bloqueio de Classe A: a entrega está barrada até que a álgebra passe.'
                : 'A álgebra passou. O que resta é julgamento revisável.'}
            </div>
          </div>
          <div className="chips">
            {result?.qa?.bloqueado
              ? <span className="badge erro grande"><span className="ponto" />bloqueada</span>
              : <span className="badge ok grande"><span className="ponto" />liberada</span>}
          </div>
        </div>

        <div className="painel-corpo">
          <div className="grade-cartoes">
            {anos.map((a) => {
              const b = result.shadow.balance[a.campo];
              return (
                <div className="cartao" key={a.campo}>
                  <div className="rotulo">{a.header}</div>
                  <div className={`valor ${b.fecha ? 'valor-ok' : 'valor-erro'}`} style={{ fontSize: 18 }}>
                    {moeda(b.dif)}
                  </div>
                  <div className="nota">
                    diferença · {percentual(b.difRelativa, 3)} do Ativo · tolerância {moeda(b.tolerancia)}
                  </div>
                </div>
              );
            })}
          </div>

          {balance ? (
            <div className="tabela-envelope">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Indicador</th>
                    {anos.map((a) => <th key={a.campo} className="num">{a.header}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['Total do Ativo', 'totalAtivo'],
                    ['Total do Passivo', 'totalPassivo'],
                    ['Patrimônio Líquido', 'patrimonioLiquido'],
                    ['Recursos Próprios', 'recursosProprios'],
                    ['Vendas Totais', 'vendasTotais'],
                    ['Lucro Líquido (linha 35)', 'lucroLiquido'],
                  ].map(([rotulo, campo]) => (
                    <tr key={campo}>
                      <td>{rotulo}</td>
                      {anos.map((a) => (
                        <td key={a.campo} className="num">
                          {moeda(result.shadow.totals[a.campo]?.[campo])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="linha-subtotal">
                    <td>Conservação de valor</td>
                    {anos.map((a) => (
                      <td key={a.campo} className="num">
                        {result.shadow.trilha.conservado[a.campo] ? 'conserva' : 'VAZA'}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>

      <section className="painel">
        <div className="painel-cabecalho"><h2>Identificação e salvamento</h2></div>
        <div className="painel-corpo">
          <div className="campos-2">
            <div className="campo">
              <label htmlFor="rs-empresa">Empresa</label>
              <input
                id="rs-empresa"
                type="text"
                value={meta.empresa}
                onChange={(e) => aoTrocarMeta({ empresa: e.target.value })}
              />
            </div>
            <div className="campo">
              <label htmlFor="rs-cliente">Cliente</label>
              <select
                id="rs-cliente"
                value={meta.clienteId ?? ''}
                onChange={(e) => aoTrocarMeta({ clienteId: e.target.value || null })}
              >
                <option value=""> - sem cliente - </option>
                {clientes.map((c) => <option key={c.id} value={c.id}>{c.nome}</option>)}
              </select>
              <div className="ajuda">
                Sem cliente não há memória: as decisões desta análise não se reaproveitam na
                próxima do mesmo balanço.
              </div>
            </div>
            <div className="campo">
              <label htmlFor="rs-status">Status</label>
              <select
                id="rs-status"
                value={meta.status}
                onChange={(e) => aoTrocarMeta({ status: e.target.value })}
              >
                <option value="rascunho">rascunho</option>
                <option value="em_revisao">em revisão</option>
                <option value="concluida">concluída</option>
              </select>
            </div>
            <div className="campo">
              <label htmlFor="rs-cnpj">CNPJ</label>
              <input
                id="rs-cnpj"
                type="text"
                value={meta.cnpj}
                onChange={(e) => aoTrocarMeta({ cnpj: e.target.value })}
              />
            </div>
          </div>

          {meta.status === 'concluida' && result?.qa?.bloqueado ? (
            <div className="aviso erro">
              <div className="aviso-titulo">
                Não marque como concluída com bloqueio de Classe A pendente.
              </div>
              <div className="aviso-dica">
                A memória do cliente só deve aprender de análise conciliada - um rascunho
                quebrado envenena a memória e o erro reaparece em todas as análises seguintes.
              </div>
            </div>
          ) : null}

          <div className="linha-botoes">
            <button type="button" className="primario" onClick={aoSalvar} disabled={salvando}>
              {salvando ? <span className="girando" /> : null}
              salvar análise
            </button>
            <button
              type="button"
              onClick={aoAbrirMemoria}
              disabled={!meta.clienteId}
              title={meta.clienteId
                ? 'Compara a memória gravada com o que esta análise propõe, antes de gravar'
                : 'Escolha um cliente para poder salvar a memória'}
            >
              salvar memória do cliente…
            </button>
            <span className="espaco" />
            <button type="button" onClick={exportarCsv}>exportar rastreabilidade (CSV)</button>
            <button type="button" onClick={exportarJson}>exportar análise (JSON)</button>
          </div>
        </div>
      </section>

      <section className="painel">
        <div className="painel-cabecalho">
          <div>
            <h2>Parecer</h2>
            <div className="fraco">
              Só prosa: o parecer nunca altera dado. É a única etapa em que a saída do modelo
              não passa por guardrail, justamente porque não tem como afetar um número.
            </div>
          </div>
          <button
            type="button"
            onClick={gerarParecer}
            disabled={gerando || !apiInferencia}
            title={apiInferencia ? '' : 'Exige o plano de inferência configurado'}
          >
            {gerando ? <span className="girando" /> : null}
            gerar com IA
          </button>
        </div>
        <div className="painel-corpo">
          <textarea
            value={textoParecer}
            onChange={(e) => setTextoParecer(e.target.value)}
            placeholder="Escreva o parecer, ou gere um rascunho com IA e revise."
            style={{ minHeight: 180, fontFamily: 'inherit', fontSize: 13 }}
          />
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------
export default function Analise({ analiseId = null }) {
  const { avisar, config } = useApp();
  const navegar = useNavigate();

  const [etapa, setEtapa] = useState(1);
  const [linhas, setLinhas] = useState([]);
  const [leitura, setLeitura] = useState(null);
  const [saldosAbsolutos, setSaldosAbsolutos] = useState(false);
  const [transportarResultado, setTransportarResultado] = useState(false);
  // Escolha do analista: `{ BP: 'p6', DRE: 'p7' }` e, por demonstração,
  // `{ p6: { 'Ano 3': 'Consolidado 30/06/2026' } }`. Vazios quando o documento
  // não é demonstração publicada (balancete de ERP, colado, digitado).
  const [escolha, setEscolha] = useState({});
  const [mapeamento, setMapeamento] = useState({});
  const [dicionario, setDicionario] = useState(null);
  const [memoria, setMemoria] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [meta, setMeta] = useState({
    id: null, clienteId: null, empresa: '', cnpj: '', grupo: '', status: 'rascunho',
  });
  const [salvando, setSalvando] = useState(false);
  const [salvandoMemoria, setSalvandoMemoria] = useState(false);
  const [abrirMemoria, setAbrirMemoria] = useState(false);
  const [linhaFoco, setLinhaFoco] = useState(null);
  const [julgando, setJulgando] = useState(false);

  // Dicionário e clientes: uma vez.
  useEffect(() => {
    let vivo = true;
    listarDicionario()
      .then((d) => { if (vivo) setDicionario(d); })
      .catch(() => { if (vivo) setDicionario([]); });
    listarClientes()
      .then((c) => { if (vivo) setClientes(c); })
      .catch(() => { if (vivo) setClientes([]); });
    return () => { vivo = false; };
  }, []);

  // Análise salva: carrega as LINHAS DE ENTRADA e recalcula. Não restauramos o
  // `qa`/`trilha` gravados: eles são snapshot de auditoria, e recalcular é o que
  // garante que a tela mostre o resultado do motor ATUAL, não de uma versão
  // antiga que pode ter tido um bug.
  useEffect(() => {
    if (!analiseId) return;
    let vivo = true;
    obterAnalise(analiseId)
      .then((a) => {
        if (!vivo || !a) return;
        setMeta({
          id: a.id,
          clienteId: a.clienteId ?? null,
          empresa: a.empresa ?? '',
          cnpj: a.cnpj ?? '',
          grupo: a.grupo ?? '',
          status: a.status ?? 'rascunho',
        });
        setSaldosAbsolutos(Boolean(a.saldosAbsolutos));
        setTransportarResultado(Boolean(a.transportarResultado));
        setLinhas((a.linhas ?? []).map((l) => ({ ...l, id: l.id ?? novoIdLinha() })));
        setLeitura({
          fonte: 'salva',
          arquivo: { nome: `análise salva · ${a.empresa || a.id}` },
          linhas: a.linhas ?? [],
          periodos: a.periodos ?? [],
          avisos: [],
          saldosAbsolutos: Boolean(a.saldosAbsolutos),
        });
        setEtapa(3);
      })
      .catch((e) => avisar('erro', 'Não consegui abrir a análise.',
        e?.dica || 'Confira a URL de dados em Configurações.'));
    return () => { vivo = false; };
  }, [analiseId, avisar]);

  // Memória do cliente escolhido. Trocar de cliente TROCA a camada de memória e
  // o pipeline recalcula - é o comportamento desejado.
  useEffect(() => {
    let vivo = true;
    if (!meta.clienteId) { setMemoria([]); return () => { vivo = false; }; }
    carregarMemoria(meta.clienteId)
      .then((m) => { if (vivo) setMemoria(m); })
      .catch(() => { if (vivo) setMemoria([]); });
    return () => { vivo = false; };
  }, [meta.clienteId]);

  // ===========================================================================
  // O PIPELINE. Derivado, nunca guardado.
  // ===========================================================================
  const result = useMemo(() => {
    if (!linhas.length) return null;
    return runPipeline(linhas, {
      // `dicionario: null` deixa o núcleo usar o DICIONARIO_SEED. Passar `[]`
      // desligaria o dicionário inteiro, o que é bem diferente de "ainda estou
      // carregando" - e a diferença apareceria como centenas de linhas sem
      // destino, parecendo erro de leitura.
      ...(dicionario && dicionario.length ? { dicionario } : {}),
      companyMemory: memoria,
      saldosAbsolutos,
      transportarResultado,
    });
  }, [linhas, dicionario, memoria, saldosAbsolutos, transportarResultado]);

  const atualizarLinha = useCallback((id, patch) => {
    setLinhas((atual) => atual.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  /**
   * ÚLTIMO RECURSO: manda o que sobrou para a posição residual do próprio bloco.
   *
   * Existe porque o modelo local se abstém de forma DETERMINÍSTICA em conta de
   * nome genérico - dois rounds de julgamento no ITR do Fleury devolveram
   * `destino vazio` para as MESMAS quatro linhas, com a mesma contagem de tokens.
   * Reclicar não resolve.
   *
   * E o custo do branco é desproporcional: `sem-destino` é Classe A e bloqueia a
   * entrega, enquanto a residual está no bloco correto e preserva
   * `Ativo = Passivo + PL`. Cada linha volta marcada como `Residual` com aviso de
   * Classe B nominal - a ferramenta propõe, nunca decide calada.
   */
  const completarResidual = useCallback(() => {
    if (!result) return;
    const { patches, semResidual } = patchesResiduais(result.rows);
    if (!patches.length && !semResidual.length) {
      avisar('ok', 'Nenhuma linha sem destino.', 'Não há o que completar.');
      return;
    }
    if (!patches.length) {
      avisar('atencao', `${semResidual.length} linha(s) sem bloco definido.`,
        'Sem Grupo · Sub não existe posição residual, e inventar um destino aqui '
        + 'escolheria o LADO do balanço no seu lugar. Defina o bloco na grade.');
      return;
    }
    // Escreve nas linhas de ORIGEM: o pipeline recalcula a partir delas. Aplicar
    // sobre `result.rows` faria a regra de sinal rodar duas vezes.
    for (const p of patches) atualizarLinha(p.id, p.patch);
    const resumo = patches.map((p) => `${p.origem} → ${p.patch.destino}`).join(' · ');
    avisar('atencao', `${patches.length} linha(s) na posição residual do bloco`
      + (semResidual.length ? ` · ${semResidual.length} sem bloco definido` : ''),
      `${resumo}. O balanço fecha, mas o INDICADOR muda: valor em `
      + '"Outros Operacionais" não lê liquidez como a posição nomeada leria. '
      + 'Cada uma está no QA como Classe B - confirme ou troque na grade.');
  }, [result, atualizarLinha, avisar]);

  /**
   * Edição de valor por período.
   *
   * Escreve o texto cru E declara a natureza D/C correspondente ao SINAL que o
   * analista digitou. Sem declarar a natureza, num documento marcado como "saldos
   * absolutos" o núcleo aplicaria `Math.abs()` e um valor negativo digitado
   * voltaria positivo - o analista corrigiria a tela e o número não mudaria, que
   * é o pior tipo de bug de interface.
   */
  const editarValor = useCallback((linhaResultado, periodo, texto) => {
    const p = parseNumber(texto);
    const esperada = naturezaEsperada(linhaResultado.grupo);
    let natureza = '';
    if (esperada && p.ok && p.value !== null) {
      const contraria = esperada === NATUREZA.DEBITO ? NATUREZA.CREDITO : NATUREZA.DEBITO;
      natureza = p.value < 0 ? contraria : esperada;
    }
    setLinhas((atual) => atual.map((l) => {
      if (l.id !== linhaResultado.id) return l;
      return {
        ...l,
        valoresPorSlot: { ...(l.valoresPorSlot ?? {}), [periodo]: texto },
        naturezaPorSlot: { ...(l.naturezaPorSlot ?? {}), [periodo]: natureza },
      };
    }));
  }, []);

  /** Retirar uma origem de uma posição da Shadow. */
  const retirarOrigem = useCallback((id) => {
    atualizarLinha(id, {
      alocacaoHierarquia: 'Não',
      destino: '',
      // Sem `noAuto`, o dicionário realocaria a conta no próximo recálculo e a
      // decisão do analista se desfaria em silêncio - comportamento da v1.
      noAuto: true,
      confirmadoPorHumano: true,
    });
    avisar('ok', 'Conta retirada da posição.',
      'A decisão negativa entra na memória do cliente ao salvar: nenhuma camada automática '
      + 'vai realocá-la na próxima análise deste balanço.');
  }, [atualizarLinha, avisar]);

  const irParaLinha = useCallback((id) => {
    setEtapa(3);
    setLinhaFoco(id);
  }, []);

  const carregarLeitura = useCallback((res) => {
    setLeitura(res);
    // Demonstração publicada: o servidor manda TODAS as demonstrações que achou e
    // uma proposta de mapeamento. A escolha padrão é uma por família - e fica
    // visível e trocável na Conferência, em vez de decidida em silêncio.
    const demonstracoes = res.demonstracoes ?? [];
    const inicial = demonstracoes.length ? escolhaPadrao(demonstracoes) : {};
    setEscolha(inicial);
    setMapeamento({});
    setLinhas((res.linhas ?? []).map((l) => ({ ...l, id: l.id ?? novoIdLinha() })));
    if (res.saldosAbsolutos) setSaldosAbsolutos(true);
    setTransportarResultado(false);
    setEtapa(2);
  }, []);

  /**
   * Reaplica a seleção sobre as demonstrações que já estão no navegador.
   *
   * Preserva o `id` de cada linha por (demonstração + código): sem isso, trocar
   * de coluna geraria ids novos, e o foco da grade e as edições manuais feitas
   * na Revisão se perderiam a cada troca.
   */
  const reaplicarSelecao = useCallback((novaEscolha, novoMapeamento) => {
    const demonstracoes = leitura?.demonstracoes ?? [];
    if (!demonstracoes.length) return;
    const { linhas: recalculadas } = aplicarSelecao(
      demonstracoes, novaEscolha, novoMapeamento,
    );
    setLinhas((anteriores) => {
      const idPor = new Map(
        anteriores.map((l) => [`${l.demonstracao}|${l.codigo}|${l.origem}`, l.id]),
      );
      return recalculadas.map((l) => ({
        ...l,
        id: idPor.get(`${l.demonstracao}|${l.codigo}|${l.origem}`) ?? novoIdLinha(),
      }));
    });
  }, [leitura]);

  const trocarEscolha = useCallback((chave, id) => {
    setEscolha((atual) => {
      const nova = { ...atual, [chave]: id };
      // Uma página que fecha Ativo E Passivo (o ITR diagramado) ocupa as duas
      // chaves. Preencher só uma deixaria o outro lado livre para receber uma
      // segunda página que também traz os dois - e aí o valor entraria em dobro,
      // porque `aplicarSelecao` inclui TODAS as linhas da página escolhida, não
      // só as do lado.
      const d = (leitura?.demonstracoes ?? []).find((x) => x.id === id);
      if (d) for (const c of chavesDeSelecao(d)) nova[c] = id;
      reaplicarSelecao(nova, mapeamento);
      return nova;
    });
  }, [mapeamento, reaplicarSelecao, leitura]);

  /**
   * O estado guarda SLOT -> COLUNA, o mesmo formato que `aplicarSelecao` espera.
   * A tela pensa em "esta coluna vira qual Ano?", mas converter aqui, num lugar
   * só, evita manter duas representações da mesma escolha.
   */
  const trocarMapeamento = useCallback((demonstracaoId, coluna, slot) => {
    setMapeamento((atual) => {
      const proposto = (leitura?.demonstracoes ?? [])
        .find((d) => d.id === demonstracaoId)?.mapeamento?.porSlot ?? {};
      const porSlot = { ...proposto, ...(atual[demonstracaoId] ?? {}) };

      // Uma coluna ocupa UM slot: liberar a posição anterior dela é o que impede
      // a mesma coluna alimentar dois Anos.
      for (const s of SLOTS) if (porSlot[s] === coluna) porSlot[s] = null;
      // E um slot recebe UMA coluna: atribuir sobrescreve a anterior.
      if (slot) porSlot[slot] = coluna;

      const nova = { ...atual, [demonstracaoId]: porSlot };
      reaplicarSelecao(escolha, nova);
      return nova;
    });
  }, [escolha, leitura, reaplicarSelecao]);

  /**
   * Julgamento das contas que sobraram - UMA CHAMADA POR BLOCO.
   *
   * Por bloco, e não uma chamada só, porque `candidatos` tem de estar restrito ao
   * bloco compatível: é essa redução (de 79 para ~9-15 destinos) que torna um
   * modelo local de 7B confiável na tarefa. Mandar as 79 soltas devolveria o
   * problema à dificuldade original.
   */
  const julgar = useCallback(async () => {
    if (!result) return;
    const pendentes = pendentesDeJulgamento(result.rows);
    if (!pendentes.length) {
      avisar('ok', 'Nenhuma linha pendente de julgamento.',
        'Memória e dicionário resolveram tudo que tinha valor - nenhum token gasto.');
      return;
    }
    setJulgando(true);
    try {
      const porBloco = new Map();
      for (const r of pendentes) {
        const k = `${r.grupo}|${r.subCategoria}`;
        if (!porBloco.has(k)) porBloco.set(k, []);
        porBloco.get(k).push(r);
      }

      let aceitas = 0;
      let descartadas = 0;
      const semGrupo = [];
      for (const [k, doBloco] of porBloco) {
        const [grupo, sub] = k.split('|');
        if (!grupo) { semGrupo.push(...doBloco); continue; }
        const candidatos = candidatosPara(grupo, sub);
        const enviar = doBloco.map((r) => ({
          id: r.id,
          origem: r.origem,
          codigo: r.codigo,
          grupo: r.grupo,
          subCategoria: r.subCategoria,
          // Nome sem o cabeçalho de seção que a leitura grudou e sem referência
          // de nota (ver core/secoes.js). Vai junto com `origem`, não em lugar
          // dela: o guardrail confere a origem contra o documento.
          contaLimpa: r._contaLimpa || '',
          // A cadeia de contas-pai é o contexto que mais melhora o julgamento:
          // "o filho segue o pai" é a regra do domínio.
          cadeiaPais: r._cadeiaPais ?? [],
          ano3: r.ano3,
        }));
        const resposta = await julgamental(enviar, candidatos);
        descartadas += (resposta.descartadas ?? []).length;
        for (const s of resposta.sugestoes ?? []) {
          const alvo = s.id || doBloco.find((r) => r.origem === s.origem)?.id;
          if (!alvo) continue;
          atualizarLinha(alvo, {
            destino: s.destino,
            grupo: s.grupo,
            subCategoria: s.subCategoria,
            tipoMapeamento: 'Julgamental',
            confiancaMapeamento: s.confianca,
            justificativa: s.justificativa ?? '',
          });
          aceitas += 1;
        }
      }

      const partes = [`${aceitas} sugestão(ões) aplicada(s)`];
      if (descartadas) partes.push(`${descartadas} descartada(s) pelos guardrails`);
      if (semGrupo.length) partes.push(`${semGrupo.length} sem grupo definido`);
      avisar(aceitas ? 'ok' : 'atencao', partes.join(' · '),
        semGrupo.length
          ? 'As linhas sem grupo não foram enviadas: sem grupo não há bloco compatível e não '
            + 'há como restringir os candidatos. Defina Grupo · Sub na grade e repita.'
          : 'Toda sugestão passou pelos guardrails: destino no plano, lado preservado, sinal '
            + 'compatível e origem existente no documento. O que não passou virou revisão humana.');
    } catch (e) {
      avisar('erro', e?.message || 'O julgamento falhou.',
        e?.dica || 'Preencha os destinos à mão na grade: o seletor já oferece só as posições '
        + 'do bloco compatível, então não é possível criar um erro de Classe A por ali.');
    } finally {
      setJulgando(false);
    }
  }, [result, atualizarLinha, avisar]);

  const salvar = useCallback(async () => {
    if (!result) return;
    setSalvando(true);
    try {
      const ultimoAno = (anosComDados(result.yearHeaders).slice(-1)[0])?.campo ?? 'ano3';
      const b = result.shadow.balance[ultimoAno];
      const salva = await salvarAnalise({
        ...meta,
        saldosAbsolutos,
        transportarResultado,
        periodos: result.years,
        linhas,
        qa: result.qa,
        trilha: result.shadow.trilha,
        balancoFechado: Boolean(b?.fecha),
        conciliado: Boolean(b?.fecha) && Boolean(result.shadow.trilha?.ok)
          && !result.qa.bloqueado,
      });
      setMeta((m) => ({ ...m, id: salva.id }));
      avisar('ok', 'Análise salva.');
      if (!analiseId && salva.id) navegar(`/analise/${salva.id}`, { replace: true });
    } catch (e) {
      avisar('erro', e?.message || 'Não consegui salvar.',
        e?.dica || 'Exporte o JSON para não perder o trabalho enquanto investiga.');
    } finally {
      setSalvando(false);
    }
  }, [result, meta, saldosAbsolutos, transportarResultado, linhas, avisar, analiseId, navegar]);

  const gravarMemoria = useCallback(async (entradas, resumo) => {
    setSalvandoMemoria(true);
    try {
      await salvarMemoria(meta.clienteId, entradas, {
        analiseId: meta.id,
        observacao: `${resumo.novas} novas · ${resumo.alteradas} alteradas · `
          + `${resumo.naoAlocar} não alocar`,
        resumo,
      });
      const atualizada = await carregarMemoria(meta.clienteId);
      setMemoria(atualizada);
      setAbrirMemoria(false);
      avisar('ok', `Memória gravada: ${entradas.length} decisão(ões).`,
        'Nova revisão criada; nenhuma anterior foi sobrescrita. As decisões negativas também '
        + 'estão lá, então o dicionário não vai realocar o que você retirou.');
    } catch (e) {
      avisar('erro', e?.message || 'Não consegui gravar a memória.', e?.dica || '');
    } finally {
      setSalvandoMemoria(false);
    }
  }, [meta.clienteId, meta.id, avisar]);

  const nomeCliente = clientes.find((c) => c.id === meta.clienteId)?.nome ?? '';
  const podeAvancar = linhas.length > 0;

  return (
    <>
      <div className="cabecalho-pagina">
        <div>
          <h1>{meta.empresa || 'Nova análise'}</h1>
          <div className="subtitulo">
            O pipeline recalcula a cada edição, no navegador. O resultado nunca é guardado em
            estado: ele é sempre derivado das linhas, então não existe balanço velho na tela.
          </div>
        </div>
        <div className="chips">
          {result ? (
            <>
              <span className="badge">{inteiro(result.rows.length)} linhas</span>
              <span className={`badge ${result.shadow.trilha.ok ? 'ok' : 'erro'}`}>
                <span className="ponto" />
                {result.shadow.trilha.ok ? 'conserva valor' : 'vaza valor'}
              </span>
              <span className={`badge ${result.qa.bloqueado ? 'erro' : 'ok'}`}>
                <span className="ponto" />
                {result.qa.bloqueado
                  ? `${result.qa.summary.nBloqueantes} bloqueio(s)`
                  : 'sem bloqueio'}
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="etapas">
        {ETAPAS.map((e) => (
          <button
            key={e.n}
            type="button"
            className={`etapa${etapa === e.n ? ' atual' : ''}${etapa > e.n ? ' feita' : ''}`}
            disabled={e.n > 1 && !podeAvancar}
            title={e.n > 1 && !podeAvancar ? 'Carregue um documento primeiro' : ''}
            onClick={() => setEtapa(e.n)}
          >
            <span className="n">{e.n}</span>
            {e.rotulo}
          </button>
        ))}
      </div>

      {etapa === 1 ? (
        <EtapaDocumento aoCarregar={carregarLeitura} apiInferencia={config.apiInferencia} />
      ) : null}

      {etapa === 2 ? (
        <EtapaConferencia
          leitura={leitura}
          result={result}
          saldosAbsolutos={saldosAbsolutos}
          aoTrocarSaldosAbsolutos={setSaldosAbsolutos}
          escolha={escolha}
          mapeamento={mapeamento}
          aoTrocarEscolha={trocarEscolha}
          aoTrocarMapeamento={trocarMapeamento}
          aoConfirmar={() => setEtapa(3)}
          aoVoltar={() => setEtapa(1)}
        />
      ) : null}

      {etapa === 3 && result ? (
        <>
          <div className="linha-botoes" style={{ marginBottom: 12 }}>
            <button
              type="button"
              onClick={julgar}
              disabled={julgando || !config.apiInferencia}
              title={config.apiInferencia
                ? 'Envia ao modelo apenas os NOMES das contas pendentes, com candidatos restritos ao bloco'
                : 'Exige o plano de inferência configurado. Preencha os destinos à mão na grade.'}
            >
              {julgando ? <span className="girando" /> : null}
              julgar contas pendentes com IA
              {result ? ` (${pendentesDeJulgamento(result.rows).length})` : ''}
            </button>
            {/* Só aparece quando ainda há pendência: é último recurso, não rotina.
                O modelo se abstém de forma determinística em nome genérico, e
                deixar em branco bloqueia a entrega (Classe A) enquanto a residual
                do bloco preserva a identidade e vira aviso revisável. */}
            {pendentesDeJulgamento(result.rows).length ? (
              <button
                type="button"
                onClick={completarResidual}
                title={'Manda o que sobrou para a posição "Outros ..." do próprio bloco. '
                  + 'A identidade continua fechando porque o bloco é o mesmo lado do '
                  + 'balanço, mas o indicador muda - cada linha vira aviso de Classe B.'}
              >
                completar com a residual do bloco
                {` (${pendentesDeJulgamento(result.rows).length})`}
              </button>
            ) : null}
            <span className="espaco" />
            <button type="button" className="primario" onClick={() => setEtapa(4)}>
              ir para o resultado
            </button>
          </div>

          <TrilhaDeValor result={result} aoIrParaLinha={irParaLinha} />
          <PainelQA
            result={result}
            transportarResultado={transportarResultado}
            aoTransportar={setTransportarResultado}
            aoIrParaLinha={irParaLinha}
          />
          <ShadowView result={result} onRetirar={retirarOrigem} />
          <GradeRastreabilidade
            result={result}
            aoEditarLinha={atualizarLinha}
            aoEditarValor={editarValor}
            linhaFoco={linhaFoco}
            aoLimparFoco={() => setLinhaFoco(null)}
          />
        </>
      ) : null}

      {etapa === 3 && !result ? (
        <div className="painel">
          <div className="vazio">
            Nenhuma linha carregada. Volte à etapa Documento.
          </div>
        </div>
      ) : null}

      {etapa === 4 && result ? (
        <EtapaResultado
          result={result}
          meta={meta}
          aoTrocarMeta={(p) => setMeta((m) => ({ ...m, ...p }))}
          clientes={clientes}
          salvando={salvando}
          aoSalvar={salvar}
          aoAbrirMemoria={() => setAbrirMemoria(true)}
          apiInferencia={config.apiInferencia}
          avisar={avisar}
        />
      ) : null}

      {abrirMemoria && result ? (
        <DiffMemoria
          rows={result.rows}
          memoriaAtual={memoria}
          nomeCliente={nomeCliente}
          salvando={salvandoMemoria}
          aoSalvar={gravarMemoria}
          aoDescartar={() => setAbrirMemoria(false)}
        />
      ) : null}
    </>
  );
}
