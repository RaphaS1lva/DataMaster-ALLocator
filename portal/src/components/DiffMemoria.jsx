// DIFF DE MEMÓRIA - o painel que aparece ANTES de gravar.
//
// Memória que se grava sozinha é memória em que ninguém confia: basta uma
// análise ruim para envenenar o cliente, e sem revisão não há como saber quando
// aconteceu. Por isso o salvamento é OPT-IN e mostra o diff na frente:
//
//     Salvar memória de SPE (exemplo)?            [x]
//       → 41 regras novas
//       →  7 alteradas (destino mudou)
//       →  3 marcadas "não alocar"
//       → 12 confirmadas sem mudança
//
// O checkbox começa MARCADO (é o caminho desejado no fluxo normal), mas nada é
// gravado sem o clique em salvar.
//
// O PONTO CENTRAL: as decisões NEGATIVAS também são guardadas. Quando o analista
// retira uma conta de uma linha, ele está dizendo "esta origem não pertence a
// este destino" - informação tão valiosa quanto alocá-la. Na v1 a exportação de
// memória olhava apenas linhas alocadas COM destino, então a retirada era
// descartada e, na análise do mês seguinte, o dicionário realocava exatamente a
// mesma conta no mesmo lugar errado. O analista refazia o mesmo trabalho manual
// todo mês, para sempre. `decisao = 'nao_alocar'` é o registro que impede isso.
//
// `destinoMudou` e `decisaoMudou` são contados de forma DISJUNTA: uma entrada que
// virou `nao_alocar` também "perdeu o destino", mas contá-la nas duas linhas
// infla os números e ensina o analista a aprovar sem ler.

import { useMemo, useState } from 'react';
import { memoriaDeRows } from '../core/index.js';
import { montarDiffMemoria } from '../lib/apresentacao.js';
import { truncar } from '../lib/formato.js';

const ROTULO_DECISAO = {
  alocar: 'alocar',
  nao_alocar: 'não alocar',
  contexto: 'contexto',
};

function Detalhes({ diff }) {
  return (
    <div className="pilha">
      {diff.novas.length ? (
        <div>
          <h4>Novas · {diff.novas.length}</h4>
          <div className="tabela-envelope" style={{ maxHeight: 220 }}>
            <table className="tabela">
              <thead>
                <tr><th>Origem</th><th>Destino</th><th>Grupo · Sub</th><th>Decisão</th></tr>
              </thead>
              <tbody>
                {diff.novas.map((e, i) => (
                  <tr key={`n-${i}`}>
                    <td>{truncar(e.origem, 44)}</td>
                    <td>{e.destino || <span className="fraco"> - </span>}</td>
                    <td className="fraco">{e.grupo}{e.subCategoria ? ` · ${e.subCategoria}` : ''}</td>
                    <td>
                      <span className={`badge ${e.decisao === 'alocar' ? 'ok' : 'atencao'}`}>
                        {ROTULO_DECISAO[e.decisao] ?? e.decisao}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {diff.alteradas.length ? (
        <div>
          <h4>Alteradas · {diff.alteradas.length}</h4>
          <div className="tabela-envelope" style={{ maxHeight: 220 }}>
            <table className="tabela">
              <thead>
                <tr><th>Origem</th><th>Antes</th><th>Depois</th><th>O que mudou</th></tr>
              </thead>
              <tbody>
                {diff.alteradas.map((a, i) => (
                  <tr key={`a-${i}`}>
                    <td>{truncar(a.para.origem, 40)}</td>
                    <td className="fraco">
                      {a.de.destino || ' - '}
                      {' · '}
                      {ROTULO_DECISAO[a.de.decisao] ?? a.de.decisao}
                    </td>
                    <td>
                      {a.para.destino || ' - '}
                      {' · '}
                      {ROTULO_DECISAO[a.para.decisao] ?? a.para.decisao}
                    </td>
                    <td>
                      {a.decisaoMudou ? (
                        <span className="badge atencao">decisão</span>
                      ) : (
                        <span className="badge info">destino</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {diff.removidas.length ? (
        <div>
          <h4>Não aparecem mais nesta análise · {diff.removidas.length}</h4>
          <div className="fraco" style={{ marginBottom: 6 }}>
            Continuam gravadas: a revisão nova é o conjunto desta análise, e a memória é
            versionada - nada é destruído, dá para auditar e reverter.
          </div>
          <ul className="lista-simples">
            {diff.removidas.slice(0, 12).map((e, i) => (
              <li key={`r-${i}`}>
                {truncar(e.origem, 60)} → {e.destino || ROTULO_DECISAO[e.decisao] || ' - '}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * @param {{
 *   rows: Array<object>,           // `result.rows`
 *   memoriaAtual: Array<object>,   // memória carregada do cliente
 *   nomeCliente: string,
 *   salvando?: boolean,
 *   aoSalvar: (entradas:Array<object>, resumo:object)=>void,
 *   aoDescartar: ()=>void
 * }} props
 */
export default function DiffMemoria({
  rows, memoriaAtual, nomeCliente, salvando = false, aoSalvar, aoDescartar,
}) {
  // `apenasConfirmadas: false` de propósito: o diff é para o analista DECIDER, e
  // esconder as entradas não confirmadas dele tiraria justamente o que ele tem
  // de olhar. O filtro por confirmação existe na promoção ao dicionário global,
  // que é outra decisão - lá, só o que um humano aprovou pode subir.
  const proposta = useMemo(() => memoriaDeRows(rows, { apenasConfirmadas: false }), [rows]);
  const diff = useMemo(() => montarDiffMemoria(memoriaAtual, proposta), [memoriaAtual, proposta]);
  const [marcado, setMarcado] = useState(true);
  const [verDetalhes, setVerDetalhes] = useState(false);

  const r = diff.resumo;

  return (
    <div className="modal-fundo" role="dialog" aria-modal="true" aria-label="Salvar memória do cliente">
      <div className="modal">
        <div className="modal-cabecalho">
          <div>
            <h2>Salvar memória de {nomeCliente || 'cliente'}?</h2>
            <div className="fraco">
              Nada é gravado sem o seu clique. A memória é versionada: cada salvamento cria
              uma revisão nova e nenhuma anterior é sobrescrita.
            </div>
          </div>
          <label className="caixa-marcavel" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={marcado}
              onChange={(e) => setMarcado(e.target.checked)}
            />
            <span>gravar</span>
          </label>
        </div>

        <div className="modal-corpo">
          <table className="tabela" style={{ marginBottom: 14 }}>
            <tbody>
              <tr>
                <td>→ regras novas</td>
                <td className="num"><strong>{r.novas}</strong></td>
              </tr>
              <tr>
                <td>→ alteradas (destino mudou)</td>
                <td className="num"><strong>{r.destinoMudou}</strong></td>
              </tr>
              <tr>
                <td>→ marcadas &quot;não alocar&quot;</td>
                <td className="num"><strong>{r.naoAlocar}</strong></td>
              </tr>
              <tr>
                <td>→ confirmadas sem mudança</td>
                <td className="num"><strong>{r.inalteradas}</strong></td>
              </tr>
              {r.decisaoMudou ? (
                <tr>
                  <td className="fraco">→ mudaram de decisão (passaram a não alocar, ou voltaram a alocar)</td>
                  <td className="num fraco">{r.decisaoMudou}</td>
                </tr>
              ) : null}
              {r.contexto ? (
                <tr>
                  <td className="fraco">→ marcadas como contexto (sintéticas e totalizadores)</td>
                  <td className="num fraco">{r.contexto}</td>
                </tr>
              ) : null}
              <tr className="linha-subtotal">
                <td>total na revisão</td>
                <td className="num">{r.total}</td>
              </tr>
            </tbody>
          </table>

          <div className="aviso info">
            <div className="aviso-titulo">
              As decisões NEGATIVAS também são guardadas - e é isso que muda o dia a dia.
            </div>
            Quando você retira uma conta de uma linha, isso vira uma regra
            <code> nao_alocar</code>: nenhuma camada automática vai realocá-la na próxima
            análise deste cliente. Na v1 só as alocações positivas eram exportadas, então a
            retirada era perdida e o dicionário devolvia a conta ao mesmo lugar errado,
            obrigando a refazer o mesmo trabalho manual a cada análise do mesmo cliente.
            {r.naoAlocar ? (
              <div className="aviso-dica">
                Esta revisão carrega <strong>{r.naoAlocar}</strong> decisão(ões) negativa(s).
              </div>
            ) : null}
          </div>

          {!diff.temMudanca ? (
            <div className="aviso ok">
              <div className="aviso-titulo">Nada mudou em relação à memória gravada.</div>
              <div className="aviso-dica">
                Pode descartar sem perda: a revisão nova seria idêntica à anterior.
              </div>
            </div>
          ) : null}

          {verDetalhes ? <Detalhes diff={diff} /> : null}
        </div>

        <div className="modal-rodape">
          <button type="button" className="discreto" onClick={() => setVerDetalhes((v) => !v)}>
            {verDetalhes ? 'esconder detalhes' : 'ver detalhes'}
          </button>
          <span className="espaco" />
          <button type="button" onClick={aoDescartar} disabled={salvando}>descartar</button>
          <button
            type="button"
            className="primario"
            disabled={!marcado || salvando || !proposta.length}
            title={!marcado ? 'Marque a caixa "gravar" para confirmar' : ''}
            onClick={() => aoSalvar(proposta, r)}
          >
            {salvando ? <span className="girando" /> : null}
            salvar
          </button>
        </div>
      </div>
    </div>
  );
}
