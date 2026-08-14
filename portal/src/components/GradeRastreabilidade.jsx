// GRADE DE RASTREABILIDADE - a aba de auditoria, editável.
//
// A decisão de desenho mais importante deste componente é o SELETOR DE DESTINO.
// Ele oferece exclusivamente `candidatosPara(grupo, sub)` - ~9 a 15 posições do
// bloco compatível - e nunca as 79 soltas, nunca subtotais. Duas consequências:
//
//  1. O analista NÃO CONSEGUE criar um erro de Classe A pelo seletor. Destino
//     inexistente é impossível (a lista vem do plano), subtotal é impossível
//     (`candidatosPara` filtra `tipo === 'conta'`) e lado trocado é impossível
//     (a lista é filtrada pelo grupo da linha). Restam apenas escolhas de
//     julgamento, que são Classe B por construção.
//
//  2. É a mesma redução de espaço que se manda ao LLM. A interface humana e a
//     interface do modelo enxergam exatamente o mesmo conjunto de opções, o que
//     torna a revisão da sugestão comparável à decisão manual.
//
// Alocar vs contexto: o botão alterna `alocacaoHierarquia`. Ao marcar contexto,
// gravamos `noAuto: true` - sem isso o dicionário realocaria a conta no próximo
// recálculo e a decisão do analista se desfaria em silêncio, que era exatamente
// o comportamento da v1.
//
// O valor editável é o de APRESENTAÇÃO por período, não o gravado. O gravado
// (`ano1..3`) sofre `Math.abs()` quando o destino tem prefixo de sinal, então
// editá-lo diretamente deixaria o analista trabalhando contra a regra do
// template sem entender por quê.

import { useEffect, useMemo, useRef, useState } from 'react';
import { candidatosPara } from '../core/planoContas.js';
import { idsComErroClasseA } from '../lib/apresentacao.js';
import { moeda, moedaOuVazio, anosComDados, truncar } from '../lib/formato.js';

const GRUPOS = [
  { grupo: '', sub: '', rotulo: '(sem grupo)' },
  { grupo: 'Ativo', sub: 'Circulante', rotulo: 'Ativo · Circulante' },
  { grupo: 'Ativo', sub: 'Não Circulante', rotulo: 'Ativo · Não Circulante' },
  { grupo: 'Passivo', sub: 'Circulante', rotulo: 'Passivo · Circulante' },
  { grupo: 'Passivo', sub: 'Não Circulante', rotulo: 'Passivo · Não Circulante' },
  { grupo: 'Passivo', sub: 'PL', rotulo: 'Passivo · PL' },
  { grupo: 'DRE', sub: 'DRE', rotulo: 'DRE' },
];

const TIPOS_MAPEAMENTO = ['Julgamental', 'Dicionário', 'Memória do cliente', 'Manual'];

/**
 * Célula de texto com RASCUNHO LOCAL enquanto o campo está em edição.
 *
 * Sem isto o campo é injogável, e a razão é sutil: o valor exibido vem de
 * `result.rows`, que é rederivado pelo pipeline a cada tecla - e o pipeline
 * normaliza a linha com `String(x).trim()`. Digitar "CAIXA" + espaço produziria
 * "CAIXA " na entrada, o `trim` devolveria "CAIXA", o input voltaria sem o
 * espaço, e a letra seguinte grudaria: "CAIXAG". Idem para número: o parser
 * interpreta "1.500" como mil e quinhentos (milhar pt-BR), então "1.5" no meio da
 * digitação viraria outro número na tela.
 *
 * Com o rascunho, o input mostra exatamente o que foi digitado enquanto tem foco
 * e só passa a mostrar o valor canônico depois do blur - quando ver a
 * normalização aplicada é justamente o que o analista quer.
 */
function CelulaTexto({ valor, aoMudar, desabilitado, className = '', ...resto }) {
  const [rascunho, setRascunho] = useState(null);
  const canonico = valor === null || valor === undefined ? '' : String(valor);
  return (
    <input
      className={`celula-edicao ${className}`}
      value={rascunho ?? canonico}
      disabled={desabilitado}
      onChange={(e) => { setRascunho(e.target.value); aoMudar(e.target.value); }}
      onBlur={() => setRascunho(null)}
      {...resto}
    />
  );
}

/**
 * Seletor de destino restrito ao bloco.
 *
 * Quando a linha tem um destino que NÃO está entre os candidatos (veio de uma
 * análise salva, de uma sugestão descartada, ou o grupo foi trocado depois), a
 * opção é acrescentada marcada como inválida, em vez de sumir. Sumir apagaria
 * silenciosamente o dado do analista - melhor mostrar o problema.
 */
function SeletorDestino({ linha, aoMudar }) {
  const candidatos = useMemo(
    () => candidatosPara(linha.grupo, linha.subCategoria),
    [linha.grupo, linha.subCategoria],
  );
  const atual = String(linha.destino ?? '');
  const conhecido = !atual || candidatos.some((c) => c.destino === atual);

  return (
    <select
      className="celula-edicao"
      value={atual}
      onChange={(e) => aoMudar(e.target.value)}
      disabled={linha.alocacaoHierarquia !== 'Sim' || linha._transporte}
      title={
        linha.grupo
          ? `${candidatos.length} destinos compatíveis com ${linha.grupo}/${linha.subCategoria || ' - '}`
          : 'Defina o Grupo para restringir os destinos ao bloco compatível'
      }
    >
      <option value=""> - sem destino - </option>
      {!conhecido ? (
        <option value={atual}>{atual} (fora do bloco compatível)</option>
      ) : null}
      {candidatos.map((c) => (
        <option key={`${c.row}-${c.destino}`} value={c.destino}>
          {c.destino}
        </option>
      ))}
    </select>
  );
}

/**
 * @param {{
 *   result: object,
 *   aoEditarLinha: (id:string, patch:object)=>void,
 *   aoEditarValor: (linha:object, periodo:string, texto:string)=>void,
 *   linhaFoco?: string|null,
 *   aoLimparFoco?: ()=>void
 * }} props
 */
export default function GradeRastreabilidade({
  result, aoEditarLinha, aoEditarValor, linhaFoco, aoLimparFoco,
}) {
  const rows = result?.rows ?? [];
  const anos = useMemo(() => anosComDados(result?.yearHeaders), [result?.yearHeaders]);
  const comErro = useMemo(() => idsComErroClasseA(result?.qa?.issues), [result?.qa?.issues]);

  const [busca, setBusca] = useState('');
  const [filtro, setFiltro] = useState('todas');
  const refs = useRef(new Map());

  // Salto para a linha vindo do painel de QA ou da trilha. Sem isso, "ir para a
  // linha" com 358 linhas na tela seria inútil.
  useEffect(() => {
    if (!linhaFoco) return;
    const el = refs.current.get(linhaFoco);
    if (el?.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [linhaFoco]);

  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return rows.filter((r) => {
      if (filtro === 'alocadas' && r.alocacaoHierarquia !== 'Sim') return false;
      if (filtro === 'contexto' && r.alocacaoHierarquia === 'Sim') return false;
      if (filtro === 'sem-destino'
        && !(r.alocacaoHierarquia === 'Sim' && !String(r.destino ?? '').trim())) return false;
      if (filtro === 'com-erro' && !comErro.has(r.id)) return false;
      if (!q) return true;
      return `${r.origem} ${r.codigo} ${r.destino} ${r.hierarquia}`.toLowerCase().includes(q);
    });
  }, [rows, busca, filtro, comErro]);

  return (
    <section className="painel">
      <div className="painel-cabecalho">
        <div>
          <h2>Rastreabilidade</h2>
          <div className="fraco">
            {rows.length} linhas · {visiveis.length} exibidas. O seletor de destino só
            oferece as posições do bloco compatível - nunca as 79 soltas e nunca subtotais.
          </div>
        </div>
        <div className="linha-botoes">
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="buscar origem, código ou destino"
            style={{ width: 260 }}
          />
          <select value={filtro} onChange={(e) => setFiltro(e.target.value)} style={{ width: 190 }}>
            <option value="todas">todas as linhas</option>
            <option value="alocadas">só alocadas</option>
            <option value="contexto">só contexto</option>
            <option value="sem-destino">alocadas sem destino</option>
            <option value="com-erro">com erro de Classe A ({comErro.size})</option>
          </select>
        </div>
      </div>

      <div className="painel-corpo sem-espaco">
        <div className="tabela-envelope alta">
          <table className="tabela">
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>Origem</th>
                <th>Código</th>
                <th>Hierarquia</th>
                {anos.map((a) => (
                  <th key={a.campo} className="num" title="Valor de APRESENTAÇÃO (natureza D/C aplicada)">
                    {a.header}
                  </th>
                ))}
                <th style={{ minWidth: 150 }}>Grupo · Sub</th>
                <th style={{ minWidth: 200 }}>Destino</th>
                <th>Mapeamento</th>
                <th>Aloca</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((r) => {
                const erro = comErro.has(r.id);
                const aloca = r.alocacaoHierarquia === 'Sim';
                const idxGrupo = GRUPOS.findIndex(
                  (g) => g.grupo === r.grupo && g.sub === r.subCategoria,
                );
                return (
                  <tr
                    key={r.id}
                    ref={(el) => {
                      if (el) refs.current.set(r.id, el);
                      else refs.current.delete(r.id);
                    }}
                    className={[
                      erro ? 'linha-erro' : '',
                      linhaFoco === r.id ? 'linha-selecionada' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={linhaFoco === r.id ? aoLimparFoco : undefined}
                  >
                    <td>
                      <CelulaTexto
                        valor={r.origem}
                        aoMudar={(v) => aoEditarLinha(r.id, { origem: v })}
                        desabilitado={r._transporte}
                        title={r.origem}
                      />
                      {r._folha === false ? (
                        <span className="badge" title="Conta sintética: é contexto, não soma">
                          sintética
                        </span>
                      ) : null}
                      {/* A leitura da demonstração publicada gruda o cabeçalho de
                          seção na primeira conta da seção e deixa a referência de
                          nota colada. `origem` fica intocada - é o que o documento
                          diz e o guardrail confere contra ela - mas o dicionário
                          casa pelo nome limpo, e o analista precisa ver qual foi. */}
                      {r._contaLimpa ? (
                        <span
                          className="badge info"
                          title={`Casado no dicionário como "${r._contaLimpa}". O documento traz "${r.origem}": a leitura grudou o cabeçalho de seção ou a referência de nota.`}
                        >
                          lida como {truncar(r._contaLimpa, 28)}
                        </span>
                      ) : null}
                      {/* A residual é ÚLTIMO RECURSO, não decisão. Sem este selo
                          ela se pareceria com um mapeamento normal na tela - e é
                          justamente a linha que mais precisa de olho humano. */}
                      {r.tipoMapeamento === 'Residual' ? (
                        <span
                          className="badge erro"
                          title={'Nenhuma posição nomeada do bloco correspondia ao nome desta conta. '
                            + 'Foi para a posição residual: o balanço fecha, mas o indicador muda. '
                            + 'Confirme ou troque no seletor de destino.'}
                        >
                          residual · confirme
                        </span>
                      ) : null}
                      {r._transporte ? (
                        <span className="badge info">transporte</span>
                      ) : null}
                      {r.motivoNaoAlocar ? (
                        <div className="fraco" title={r.motivoNaoAlocar}>
                          {truncar(r.motivoNaoAlocar, 48)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <CelulaTexto
                        className="mono"
                        valor={r.codigo}
                        aoMudar={(v) => aoEditarLinha(r.id, { codigo: v })}
                        desabilitado={r._transporte}
                        style={{ width: 110 }}
                      />
                    </td>
                    <td className="fraco" title={(r._cadeiaPais ?? []).join(' ← ')}>
                      {truncar(r.hierarquiaDisplay || r._paiNome || '', 26)}
                    </td>
                    {anos.map((a) => {
                      const apres = r[`${a.campo}Apresentacao`];
                      const gravado = r[a.campo];
                      // Só mostramos o gravado quando ele DIFERE da apresentação
                      // (destino com prefixo de sinal). É a informação que
                      // explica "por que a soma não dá o que eu esperava".
                      const difere = apres !== null && gravado !== null
                        && Math.abs(Number(apres) - Number(gravado)) > 0.005;
                      return (
                        <td key={a.campo} className="num">
                          <CelulaTexto
                            className="num"
                            valor={apres}
                            // A página trata a natureza D/C junto com o valor: sem
                            // isso, num documento com "saldos absolutos" o núcleo
                            // aplicaria `Math.abs()` e o negativo digitado voltaria
                            // positivo - o analista corrigiria e o número não mudaria.
                            aoMudar={(v) => aoEditarValor(r, a.year, v)}
                            desabilitado={r._transporte}
                            style={{ width: 116 }}
                          />
                          {difere ? (
                            <div
                              className="fraco"
                              title="Valor GRAVADO no template: o destino tem prefixo de sinal e guarda o módulo, porque a fórmula já subtrai."
                            >
                              grava {moedaOuVazio(gravado)}
                            </div>
                          ) : null}
                        </td>
                      );
                    })}
                    <td>
                      <select
                        className="celula-edicao"
                        value={idxGrupo >= 0 ? idxGrupo : 0}
                        onChange={(e) => {
                          const g = GRUPOS[Number(e.target.value)];
                          // Trocar de grupo INVALIDA o destino: um destino de
                          // Ativo dentro do Passivo é exatamente o `lado-trocado`
                          // de Classe A. Limpamos para o analista reescolher na
                          // lista já restrita ao novo bloco.
                          aoEditarLinha(r.id, {
                            grupo: g.grupo, subCategoria: g.sub, destino: '',
                          });
                        }}
                        disabled={r._transporte}
                      >
                        {GRUPOS.map((g, i) => (
                          <option key={g.rotulo} value={i}>{g.rotulo}</option>
                        ))}
                      </select>
                      {/* Numa demonstração publicada a subcategoria não vem no
                          documento: ela é derivada do nome das contas-pai
                          (ver core/secoes.js). O analista tem de saber que este
                          campo foi DEDUZIDO, porque é ele que restringe os
                          destinos oferecidos logo ao lado. */}
                      {r._subCategoriaInferida ? (
                        <div
                          className="fraco"
                          title={`Subcategoria deduzida da hierarquia: ${
                            (r._cadeiaPais || []).join(' < ') || ' - '
                          }. O documento não a declara.`}
                        >
                          deduzida da hierarquia
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <SeletorDestino
                        linha={r}
                        aoMudar={(destino) => aoEditarLinha(r.id, {
                          destino,
                          // Escolha manual é decisão do humano: marcamos para a
                          // memória do cliente aprender dela e para o dicionário
                          // não sobrescrever.
                          tipoMapeamento: destino ? 'Manual' : '',
                          confirmadoPorHumano: Boolean(destino),
                          noAuto: true,
                        })}
                      />
                    </td>
                    <td>
                      <select
                        className="celula-edicao"
                        value={r.tipoMapeamento || ''}
                        onChange={(e) => aoEditarLinha(r.id, { tipoMapeamento: e.target.value })}
                        disabled={!aloca || r._transporte}
                      >
                        <option value=""> - </option>
                        {TIPOS_MAPEAMENTO.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      {typeof r.confiancaMapeamento === 'number' ? (
                        <div className="fraco">
                          confiança {(r.confiancaMapeamento * 100).toFixed(0)}%
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={`pequeno ${aloca ? 'primario' : ''}`}
                        disabled={r._transporte}
                        title={aloca
                          ? 'Alocando: o valor entra na Shadow. Clique para tratar como contexto.'
                          : 'Contexto: o valor NÃO entra na Shadow (é totalizador ou foi retirado). Clique para alocar.'}
                        onClick={() => aoEditarLinha(r.id, aloca
                          ? {
                            alocacaoHierarquia: 'Não',
                            destino: '',
                            // impede o dicionário de realocar no recálculo
                            noAuto: true,
                            confirmadoPorHumano: true,
                          }
                          : {
                            alocacaoHierarquia: 'Sim',
                            noAuto: true,
                            confirmadoPorHumano: true,
                          })}
                      >
                        {aloca ? 'aloca' : 'contexto'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {!visiveis.length ? (
                <tr>
                  <td colSpan={7 + anos.length}>
                    <div className="vazio">
                      Nenhuma linha com esse filtro. Limpe a busca ou troque o filtro.
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="painel-corpo">
        <div className="fraco">
          Os valores editáveis são os de <strong>apresentação</strong> (natureza D/C já
          aplicada) - é o número comparável ao documento. Quando o destino tem prefixo de
          sinal, o valor <em>gravado</em> no template é o módulo, porque a fórmula já
          subtrai; a diferença aparece abaixo da célula. Confundir os dois é o que fazia um
          bloco &quot;não fechar&quot; por 7.954.956,08 com a leitura perfeita.
          {' '}Soma das folhas alocadas no último período:{' '}
          <strong>{moeda(result?.shadow?.trilha?.folhasSim?.ano3 ?? 0)}</strong>.
        </div>
      </div>
    </section>
  );
}
