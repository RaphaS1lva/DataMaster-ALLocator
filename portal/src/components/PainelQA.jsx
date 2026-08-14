// PAINEL DE QA - a separação Classe A / Classe B, que é a distinção central do v2.
//
// CLASSE A é ÁLGEBRA. São as (e só as) condições que podem furar
// `Ativo = Passivo + PL`, mais a leitura do documento: destino inexistente,
// destino que é subtotal, lado do balanço trocado, sinal incompatível com o
// destino, código duplicado, dupla contagem, conservação violada, identidade que
// não fecha. Não é opinião - se qualquer uma falha, a entrega é barrada.
//
// CLASSE B é JULGAMENTO. Qual conta exatamente dentro do bloco certo, Circulante
// vs Não Circulante (ambos desembocam na mesma linha do template), divergência
// contra o dicionário. Afeta KPI, composição e leitura do analista - nunca o
// fechamento. Sinalizada e justificada, jamais bloqueia.
//
// Por que a distinção importa tanto que ganhou um painel próprio: é ela que
// permite ao modelo de linguagem fazer o julgamento sem que um erro dele possa
// produzir um balanço errado. Um 7B local errando a conta específica gera um
// aviso de Classe B; ele NÃO CONSEGUE gerar Classe A, porque o guardrail rejeita
// a sugestão antes de ela entrar na Rastreabilidade.
//
// O nível `action` existe para um caso só - `nao-encerrado` - e virou CARD DE
// AÇÃO em vez de mensagem de erro porque não é erro: é a natureza do documento.
// O botão liga `transportarResultado: true` e o núcleo constrói a linha de
// transporte com o valor exato. Nunca editamos valor à mão: na v1 a linha
// inserida passava outra vez pela regra de sinal e o `sinalGrupo('Passivo') = -1`
// NEGAVA o valor, fazendo a diferença crescer 2x o resultado em vez de fechar.

import { useMemo, useState } from 'react';
import { separarIssues, agruparPorCodigo, TEXTO_CLASSES } from '../lib/apresentacao.js';
import { moeda } from '../lib/formato.js';

/** Rótulo legível de cada `code` do QA - o code cru não diz nada ao analista. */
const NOMES = {
  'valor-ilegivel': 'valor não interpretado como número',
  leitura: 'erro de LEITURA (sintética x soma das folhas)',
  'sem-destino': 'linha alocada sem destino',
  'destino-invalido': 'destino inexistente no plano',
  'destino-subtotal': 'destino é subtotal calculado',
  'lado-trocado': 'lado do balanço trocado',
  'sinal-incompativel': 'sinal incompatível com o destino',
  'dupla-contagem': 'totalizador e aberturas ambos alocados',
  'codigo-duplicado': 'código contábil repetido',
  orfao: 'chave órfã na agregação',
  'valor-perdido': 'valor não chegou à Shadow',
  conservacao: 'conservação de valor violada',
  identidade: 'identidade não fecha',
  'nao-encerrado': 'balancete não encerrado',
  subcat: 'Sub Categoria inconsistente',
  'destino-inconsistente': 'mesma origem com destinos diferentes',
  retificadora: 'nome sugere retificadora, natureza diz o contrário',
  irmaos: 'aberturas do mesmo pai em destinos diferentes',
  zerada: 'linha alocada e zerada',
  'atencao-destino': 'destino de reconciliação',
  'baixa-confianca': 'julgamento com confiança baixa',
  dicionario: 'divergência contra o dicionário',
};

function Grupo({ titulo, itens, tom, aoIrParaLinha, limite = 40 }) {
  const [tudo, setTudo] = useState(false);
  if (!itens.length) return null;
  const grupos = agruparPorCodigo(itens);
  return (
    <div style={{ marginBottom: 14 }}>
      <h4>{titulo} · {itens.length}</h4>
      <div className="pilha">
        {grupos.map(({ code, itens: doCode }) => {
          const mostrar = tudo ? doCode : doCode.slice(0, limite);
          return (
            <div key={code} className={`aviso ${tom}`}>
              <div className="aviso-titulo">
                {NOMES[code] || code}
                <span className="fraco"> · {code} · {doCode.length}</span>
              </div>
              <ul className="lista-simples">
                {mostrar.map((i, n) => (
                  <li key={`${code}-${n}`}>
                    {i.msg}
                    {/* Classe A com `id` é localizável: o analista salta direto
                        para a linha em vez de procurar entre 358. */}
                    {i.id && aoIrParaLinha ? (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="pequeno discreto"
                          onClick={() => aoIrParaLinha(i.id)}
                        >
                          ir para a linha
                        </button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
              {doCode.length > mostrar.length ? (
                <button type="button" className="pequeno discreto" onClick={() => setTudo(true)}>
                  ver as outras {doCode.length - mostrar.length}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * @param {{
 *   result: object,
 *   transportarResultado?: boolean,
 *   aoTransportar?: (ligar:boolean)=>void,
 *   aoIrParaLinha?: (id:string)=>void
 * }} props
 */
export default function PainelQA({
  result, transportarResultado = false, aoTransportar, aoIrParaLinha,
}) {
  const qa = result?.qa ?? null;
  const separado = useMemo(() => separarIssues(qa?.issues), [qa?.issues]);

  if (!qa) {
    return (
      <section className="painel">
        <div className="painel-cabecalho"><h2>Qualidade</h2></div>
        <div className="vazio">Sem linhas para validar ainda.</div>
      </section>
    );
  }

  const { classeA, classeB, contagens } = separado;
  const semNada = !classeA.erros.length && !classeA.acoes.length
    && !classeB.avisos.length && !classeB.infos.length;

  return (
    <section className="painel">
      <div className="painel-cabecalho">
        <div>
          <h2>Qualidade</h2>
          <div className="fraco">
            Duas naturezas de problema, dois tratamentos. Classe A é verificada por
            código e bloqueia; Classe B é revisada por humano e nunca bloqueia.
          </div>
        </div>
        <div className="chips">
          {qa.bloqueado ? (
            <span className="badge erro grande"><span className="ponto" />entrega bloqueada</span>
          ) : (
            <span className="badge ok grande"><span className="ponto" />álgebra aprovada</span>
          )}
          {contagens.acoes ? (
            <span className="badge atencao grande">{contagens.acoes} ação pendente</span>
          ) : null}
        </div>
      </div>

      <div className="painel-corpo">
        {/* CARD DE AÇÃO - level 'action'. Não é erro; é o documento sendo o que é. */}
        {classeA.acoes.map((a) => (
          <div key={`${a.code}-${a.ano}`} className="aviso atencao destaque">
            <div className="aviso-titulo">Ação necessária: transportar o resultado para o PL</div>
            <p style={{ marginBottom: 8 }}>{a.msg}</p>
            <div className="aviso-dica" style={{ marginBottom: 10 }}>
              A identidade estendida (<code>Ativo = Passivo + PL + Resultado</code>) fecha, e a
              simples não. Isso não é erro de leitura nem de alocação: é um balancete cujo
              resultado do período ainda não foi encerrado contra o Patrimônio Líquido.
              O valor exato do transporte já é conhecido
              {typeof a.transporte === 'number' ? <> - <strong>{moeda(a.transporte)}</strong></> : null}.
            </div>
            <div className="aviso-dica" style={{ marginBottom: 10 }}>
              O botão apenas liga a opção <code>transportarResultado</code> e o motor constrói
              a linha de transporte. Nenhum valor é editado à mão: a linha nasce com o sinal
              já aplicado, justamente porque na v1 ela passava outra vez pela regra de sinal e
              a diferença crescia duas vezes o resultado em vez de fechar.
            </div>
            <div className="linha-botoes">
              {transportarResultado ? (
                <>
                  <span className="badge ok"><span className="ponto" />transporte aplicado</span>
                  <button type="button" onClick={() => aoTransportar?.(false)}>
                    desfazer transporte
                  </button>
                </>
              ) : (
                <button type="button" className="primario" onClick={() => aoTransportar?.(true)}>
                  Transportar resultado para o PL
                </button>
              )}
            </div>
          </div>
        ))}

        {/* Quando o transporte JÁ está ligado, a ação sai da lista de issues e o
            usuário perde a referência de que ele está ativo. Este bloco mantém a
            informação visível - e desfazível. */}
        {transportarResultado && !classeA.acoes.length ? (
          <div className="aviso ok">
            <div className="linha-botoes">
              <div style={{ flex: '1 1 auto' }}>
                <div className="aviso-titulo">Transporte do resultado aplicado</div>
                <div className="aviso-dica">
                  Uma linha de transporte para <code>Lucros Acumulados</code> foi inserida com
                  o valor exato do resultado do período. Ela aparece na grade marcada como
                  &quot;Transporte de resultado&quot; e não entra na memória do cliente.
                </div>
              </div>
              <button type="button" onClick={() => aoTransportar?.(false)}>desfazer</button>
            </div>
          </div>
        ) : null}

        <div className="aviso erro" style={{ background: 'transparent' }}>
          <div className="aviso-titulo">Classe A - bloqueante</div>
          <div className="aviso-dica">{TEXTO_CLASSES.A}</div>
        </div>
        {classeA.erros.length ? (
          <Grupo
            titulo="Bloqueios"
            itens={classeA.erros}
            tom="erro"
            aoIrParaLinha={aoIrParaLinha}
          />
        ) : (
          <div className="aviso ok">
            <div className="aviso-titulo">Nenhum bloqueio de Classe A.</div>
            <div className="aviso-dica">
              Leitura conferida, destinos válidos, lados preservados, valor conservado e
              identidade fechando (ou explicada). A entrega está liberada pela álgebra.
            </div>
          </div>
        )}

        <div className="aviso atencao" style={{ background: 'transparent' }}>
          <div className="aviso-titulo">Classe B - revisável</div>
          <div className="aviso-dica">{TEXTO_CLASSES.B}</div>
        </div>
        <Grupo titulo="Avisos" itens={classeB.avisos} tom="atencao" aoIrParaLinha={aoIrParaLinha} />
        <Grupo titulo="Informações" itens={classeB.infos} tom="info" aoIrParaLinha={aoIrParaLinha} />
        {!classeB.avisos.length && !classeB.infos.length ? (
          <div className="fraco">Nenhum ponto de revisão levantado.</div>
        ) : null}

        {semNada ? (
          <div className="vazio">
            Nada a reportar. Confira se as linhas foram realmente carregadas - QA vazio
            com zero linhas não significa análise aprovada.
          </div>
        ) : null}

        {/* Resumo numérico: é o que se copia para a ata da análise. */}
        <div className="grade-cartoes" style={{ marginTop: 12, marginBottom: 0 }}>
          <div className="cartao">
            <div className="rotulo">Linhas</div>
            <div className="valor">{qa.summary.linhas}</div>
            <div className="nota">
              {qa.summary.alocadas} alocadas · {qa.summary.contexto} contexto
            </div>
          </div>
          <div className="cartao">
            <div className="rotulo">Hierarquia</div>
            <div className="valor">{qa.summary.folhas}</div>
            <div className="nota">
              folhas · {qa.summary.sinteticas} sintéticas (contexto, não somam)
            </div>
          </div>
          <div className="cartao">
            <div className="rotulo">Classe A</div>
            <div className={`valor ${contagens.erros ? 'valor-erro' : 'valor-ok'}`}>
              {contagens.erros}
            </div>
            <div className="nota">{contagens.acoes} ação pendente</div>
          </div>
          <div className="cartao">
            <div className="rotulo">Classe B</div>
            <div className="valor">{contagens.avisos + contagens.infos}</div>
            <div className="nota">{contagens.avisos} avisos · {contagens.infos} infos</div>
          </div>
        </div>
      </div>
    </section>
  );
}
