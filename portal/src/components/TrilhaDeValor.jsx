// TRILHA DE VALOR - a razão de existir do v2.
//
// A equação que este painel mostra, por ano:
//
//   Σ(folhas alocadas) = Σ(chegou a uma posição)
//                      + Σ(chave órfã)
//                      + Σ(alocado em subtotal)
//                      + Σ(sem destino)
//                      + Σ(lado trocado)
//
// Nada some sem aparecer numa dessas linhas. Na v1 esse vazamento era 100%
// invisível: 229 das 1.285 regras do dicionário apontavam para destinos
// inexistentes, o valor virava zero na agregação e NADA no sistema sabia disso.
// O sintoma era `Ativo > Passivo + PL` e a orientação ao analista era
// "investigar: conta sem destino, dupla contagem, sinal ou grupo trocado" - o
// problema devolvido sem nenhuma pista de onde estava.
//
// Aqui cada balde não-zero é clicável e revela as linhas exatas, com origem e
// valor. Deixa de ser "faltam R$ 689 mil em algum lugar" e passa a ser "estas 7
// contas foram para um destino que não existe no template".
//
// O balde `memorando da DRE` é âmbar e não vermelho por um motivo importante:
// ele NÃO é perda. O valor está na Shadow e aparece na linha; só não alcança o
// Lucro Líquido, porque são posições de add-back do EBITDA ou abaixo da linha do
// resultado. Tratá-lo como perda faria o analista caçar um erro que não existe.

import { useMemo, useState } from 'react';
import { linhasDaTrilha, resumoDaTrilha } from '../lib/apresentacao.js';
import { moeda, moedaOuVazio, rotuloAno, anosComDados } from '../lib/formato.js';

/** Linhas de detalhe de um balde: quem exatamente está vazando, e quanto. */
function Detalhes({ itens, campo, anos, aoIrParaLinha }) {
  if (!itens?.length) {
    return <div className="vazio">Nenhuma linha neste balde.</div>;
  }
  return (
    <div className="tabela-envelope">
      <table className="tabela">
        <thead>
          <tr>
            <th>Origem</th>
            <th>Código</th>
            {campo === 'ladoTrocado' ? <th>Lado da conta → lado do destino</th> : null}
            {campo !== 'semDestino' ? <th>Destino tentado</th> : null}
            {campo === 'orfao' || campo === 'subtotal' ? <th>Por quê</th> : null}
            {anos.map((a) => <th key={a.campo} className="num">{a.header}</th>)}
            {aoIrParaLinha ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {itens.map((d, i) => (
            <tr key={`${d.id ?? 'sem-id'}-${i}`}>
              <td>{d.origem || <span className="fraco">(sem nome)</span>}</td>
              <td className="mono">{d.codigo || ''}</td>
              {campo === 'ladoTrocado' ? (
                <td>
                  <span className="valor-erro">{d.ladoLinha}</span>
                  {' → '}
                  <span className="valor-erro">{d.ladoDestino}</span>
                </td>
              ) : null}
              {campo !== 'semDestino' ? <td>{d.destino || ''}</td> : null}
              {campo === 'orfao' || campo === 'subtotal' ? (
                <td className="fraco">{d.erro || ''}</td>
              ) : null}
              {anos.map((a) => (
                <td key={a.campo} className="num">{moedaOuVazio(d[a.campo])}</td>
              ))}
              {aoIrParaLinha ? (
                <td>
                  {d.id ? (
                    <button
                      type="button"
                      className="pequeno discreto"
                      onClick={() => aoIrParaLinha(d.id)}
                    >
                      ver na grade
                    </button>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * @param {{result:object, aoIrParaLinha?:(id:string)=>void}} props
 *   `result` é a saída de `runPipeline`. Lê `result.shadow.trilha`.
 */
export default function TrilhaDeValor({ result, aoIrParaLinha }) {
  const trilha = result?.shadow?.trilha ?? null;
  const [aberto, setAberto] = useState(null); // `${ano}:${campo}`
  const resumo = useMemo(() => resumoDaTrilha(trilha), [trilha]);
  const anos = useMemo(() => anosComDados(result?.yearHeaders), [result?.yearHeaders]);

  if (!trilha) {
    return (
      <section className="painel">
        <div className="painel-cabecalho"><h2>Trilha de valor</h2></div>
        <div className="vazio">Sem linhas para rastrear ainda.</div>
      </section>
    );
  }

  return (
    <section className="painel">
      <div className="painel-cabecalho">
        <div>
          <h2>Trilha de valor</h2>
          <div className="fraco">
            Para onde foi cada centavo das folhas alocadas. Se a soma dos baldes abaixo
            bate com a primeira linha e todas as perdas são zero, a alocação conserva
            valor - e o fechamento passa a ser consequência, não esperança.
          </div>
        </div>
        {resumo.conserva ? (
          <span className="badge ok grande"><span className="ponto" />conserva</span>
        ) : (
          <span className="badge erro grande"><span className="ponto" />vaza valor</span>
        )}
      </div>

      <div className="painel-corpo">
        {resumo.semDados ? (
          <div className="vazio">
            Nenhum valor alocado ainda. Marque linhas para alocar e escolha os destinos.
          </div>
        ) : null}

        {resumo.anos.map((ano) => {
          const linhas = linhasDaTrilha(trilha, ano);
          const idx = Number(ano.replace('ano', '')) - 1;
          const conservaAno = Boolean(trilha.conservado?.[ano]) && (trilha.perdas?.[ano] ?? 0) === 0;
          return (
            <div key={ano} style={{ marginBottom: 18 }}>
              <div className="linha-botoes" style={{ marginBottom: 6 }}>
                <h3 style={{ margin: 0 }}>{rotuloAno(result.yearHeaders, idx)}</h3>
                {conservaAno ? (
                  <span className="badge ok"><span className="ponto" />conserva</span>
                ) : (
                  <span className="badge erro"><span className="ponto" />não conserva</span>
                )}
                {(trilha.perdas?.[ano] ?? 0) > 0.005 ? (
                  <span className="badge erro">
                    perda de {moeda(trilha.perdas[ano])}
                  </span>
                ) : null}
              </div>

              <div className="tabela-envelope">
                <table className="tabela trilha-tabela">
                  <tbody>
                    {/* `flatMap` e não `map`: uma linha pode render DUAS `<tr>` (a
                        do balde e a de detalhe). Devolver array dentro de array
                        faria o React tratar o array interno como filho sem chave. */}
                    {linhas.flatMap((l) => {
                      const chave = `${ano}:${l.campo}`;
                      const expandido = aberto === chave;
                      // Só abre o que tem detalhe E valor: clicar num balde
                      // zerado abriria uma tabela vazia e ensinaria a não clicar.
                      const clicavel = l.temDetalhes && !l.zero;
                      const classe = [
                        l.severidade === 'origem' ? 'balde-origem' : '',
                        l.alerta ? 'balde-alerta' : '',
                        l.atencao ? 'balde-atencao' : '',
                        clicavel ? 'clicavel' : '',
                      ].filter(Boolean).join(' ');
                      return [
                        <tr
                          key={chave}
                          className={classe}
                          onClick={clicavel ? () => setAberto(expandido ? null : chave) : undefined}
                        >
                          <td className="rotulo">
                            {l.severidade !== 'origem' ? <span className="seta">→</span> : null}
                            {l.rotulo}
                            {clicavel ? (
                              <span className="fraco">
                                {' '}({l.nDetalhes} {l.nDetalhes === 1 ? 'linha' : 'linhas'}
                                {expandido ? ' · fechar' : ' · clique para ver'})
                              </span>
                            ) : null}
                            <div className="explicacao">{l.explicacao}</div>
                          </td>
                          <td
                            className={`num ${
                              l.alerta ? 'valor-erro' : l.atencao ? 'valor-atencao'
                                : l.severidade === 'ok' ? 'valor-ok' : ''}`}
                          >
                            {moeda(l.valor)}
                          </td>
                        </tr>,
                        expandido ? (
                          <tr key={`${chave}-det`} className="trilha-detalhe">
                            <td colSpan={2}>
                              <Detalhes
                                itens={trilha.detalhes?.[l.campo] ?? []}
                                campo={l.campo}
                                anos={anos}
                                aoIrParaLinha={aoIrParaLinha}
                              />
                            </td>
                          </tr>
                        ) : null,
                      ].filter(Boolean);
                    })}
                  </tbody>
                </table>
              </div>

              {/* Conferência cruzada: o que a trilha CONTOU tem de ser o que a
                  agregação PRODUZIU. Divergência aqui não deveria acontecer nunca
 - se acontecer, é bug do núcleo e não da alocação, e o analista
                  precisa saber que não é ele. */}
              {Math.abs((trilha.agregado?.[ano] ?? 0) - (trilha.alocado?.[ano] ?? 0)) > 0.05 ? (
                <div className="aviso erro">
                  <div className="aviso-titulo">
                    A trilha contou {moeda(trilha.alocado[ano])} chegando às posições, mas a
                    agregação da Shadow produziu {moeda(trilha.agregado[ano])}.
                  </div>
                  <div className="aviso-dica">
                    Isto é divergência interna do motor, não erro da sua alocação. Registre
                    o caso: há um teste no núcleo que deveria impedi-lo.
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        {resumo.memoTotal > 0.005 ? (
          <div className="aviso atencao">
            <div className="aviso-titulo">
              Há {moeda(resumo.memoTotal)} em posições de memorando da DRE.
            </div>
            <div className="aviso-dica">
              Não é perda - o valor está na Shadow. Essas posições existem para divulgar
              quanto do EBIT era depreciação ou aluguel (add-back do EBITDA), ou ficam
              abaixo da linha do lucro líquido (resultados abrangentes, dividendos,
              minoritários). Elas não alcançam o Lucro Líquido, então são a explicação
              mais provável de um resíduo na identidade estendida.
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
