// Consulta ao dicionário: as 1.260 regras curadas mais as aprendidas.
//
// Por que a tela existe: quando o analista vê uma conta indo para um destino que
// ele não esperava, a primeira pergunta é "de onde veio essa regra?". Sem esta
// tela, a resposta exige abrir o código. A coluna FONTE responde:
//
//   seed       regra curada, veio do dicionário base (é a maioria)
//   aprendida  subiu de uma análise confirmada por humano
//   manual     alguém cadastrou direto
//
// A distinção não é cosmética. Na v1 um trigger aprendia de TUDO que era salvo,
// inclusive de sugestão de LLM que ninguém revisou - um erro de julgamento
// entrava no dicionário e se propagava por toda a carteira, para sempre, sem
// registro de quando. Aqui só o confirmado por humano pode subir, e a origem de
// cada regra fica visível.
//
// A validação de que TODA regra resolve para uma conta alocável é feita em teste
// (portal/test/planoContas.test.mjs), não aqui: a tela mostraria o sintoma, o
// teste impede a causa.

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { listarDicionario } from '../lib/repo.js';
import { resolveDestinoAlocavel } from '../core/planoContas.js';
import { normalizeText } from '../core/normalize.js';
import { inteiro } from '../lib/formato.js';

const BLOCOS = [
  { chave: 'Ativo|Circulante', rotulo: 'Ativo · Circulante' },
  { chave: 'Ativo|Não Circulante', rotulo: 'Ativo · Não Circulante' },
  { chave: 'Passivo|Circulante', rotulo: 'Passivo · Circulante' },
  { chave: 'Passivo|Não Circulante', rotulo: 'Passivo · Não Circulante' },
  { chave: 'Passivo|PL', rotulo: 'Passivo · PL' },
  { chave: 'DRE|DRE', rotulo: 'DRE' },
];

const LIMITE_EXIBIDO = 300;

export default function Dicionario() {
  const { avisar } = useApp();
  const [regras, setRegras] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState('');
  const [bloco, setBloco] = useState('');
  const [fonte, setFonte] = useState('');

  useEffect(() => {
    let vivo = true;
    listarDicionario()
      .then((r) => { if (vivo) setRegras(r); })
      .catch((e) => {
        if (!vivo) return;
        avisar('atencao', 'Não consegui buscar as regras do servidor.',
          e?.dica || 'As regras curadas do bundle continuam disponíveis abaixo.');
      })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [avisar]);

  const porGrupo = useMemo(() => {
    const m = new Map(BLOCOS.map((b) => [b.chave, 0]));
    for (const r of regras) {
      const k = `${r.grupo}|${r.subCategoria}`;
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [regras]);

  const porFonte = useMemo(() => {
    const m = { seed: 0, aprendida: 0, manual: 0 };
    for (const r of regras) m[r.fonte] = (m[r.fonte] ?? 0) + 1;
    return m;
  }, [regras]);

  const filtradas = useMemo(() => {
    const q = normalizeText(busca);
    return regras.filter((r) => {
      if (bloco && `${r.grupo}|${r.subCategoria}` !== bloco) return false;
      if (fonte && r.fonte !== fonte) return false;
      if (!q) return true;
      // Busca no texto NORMALIZADO: é a mesma comparação que o matching faz, então
      // "mutuo financeiro l/p" encontra "Mútuo Financeiro L/P".
      return normalizeText(`${r.origem} ${r.destino}`).includes(q);
    });
  }, [regras, busca, bloco, fonte]);

  return (
    <>
      <div className="cabecalho-pagina">
        <div>
          <h1>Dicionário</h1>
          <div className="subtitulo">
            Camada determinística de mapeamento: aplicada antes de qualquer modelo, custa
            zero token e resolve a maior parte das contas. O julgamento por IA só vê o que
            sobra daqui.
          </div>
        </div>
      </div>

      <div className="grade-cartoes">
        <div className="cartao">
          <div className="rotulo">Total de regras</div>
          <div className="valor">{carregando ? ' - ' : inteiro(regras.length)}</div>
          <div className="nota">todas resolvem para conta alocável (garantido por teste)</div>
        </div>
        <div className="cartao">
          <div className="rotulo">Curadas (seed)</div>
          <div className="valor">{inteiro(porFonte.seed)}</div>
          <div className="nota">revisadas uma a uma na migração da v1</div>
        </div>
        <div className="cartao">
          <div className="rotulo">Aprendidas</div>
          <div className="valor">{inteiro(porFonte.aprendida)}</div>
          <div className="nota">só sobem se um humano confirmou</div>
        </div>
        <div className="cartao">
          <div className="rotulo">Manuais</div>
          <div className="valor">{inteiro(porFonte.manual)}</div>
          <div className="nota">cadastradas direto no dicionário global</div>
        </div>
      </div>

      <section className="painel">
        <div className="painel-cabecalho">
          <div>
            <h2>Regras por bloco</h2>
            <div className="fraco">
              Clique num bloco para filtrar. O bloco é o que restringe o espaço de decisão do
              modelo de 79 para ~9 a 15 destinos.
            </div>
          </div>
        </div>
        <div className="painel-corpo">
          <div className="chips">
            <button
              type="button"
              className={`pequeno ${bloco === '' ? 'primario' : ''}`}
              onClick={() => setBloco('')}
            >
              todos ({inteiro(regras.length)})
            </button>
            {BLOCOS.map((b) => (
              <button
                key={b.chave}
                type="button"
                className={`pequeno ${bloco === b.chave ? 'primario' : ''}`}
                onClick={() => setBloco(bloco === b.chave ? '' : b.chave)}
              >
                {b.rotulo} ({inteiro(porGrupo.get(b.chave) ?? 0)})
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="painel">
        <div className="painel-cabecalho">
          <div className="linha-botoes" style={{ width: '100%' }}>
            <input
              type="search"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="buscar origem ou destino (ignora acento, caixa e pontuação)"
              style={{ maxWidth: 420 }}
            />
            <select value={fonte} onChange={(e) => setFonte(e.target.value)} style={{ width: 180 }}>
              <option value="">toda origem de regra</option>
              <option value="seed">seed (curada)</option>
              <option value="aprendida">aprendida</option>
              <option value="manual">manual</option>
            </select>
            <span className="espaco" />
            <span className="fraco">
              {inteiro(filtradas.length)} resultado(s)
              {filtradas.length > LIMITE_EXIBIDO ? ` · exibindo ${LIMITE_EXIBIDO}` : ''}
            </span>
          </div>
        </div>
        <div className="painel-corpo sem-espaco">
          {carregando ? (
            <div className="vazio"><span className="girando" /> carregando…</div>
          ) : (
            <div className="tabela-envelope alta">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Origem no documento</th>
                    <th>Destino</th>
                    <th>Grupo · Sub</th>
                    <th>Fonte</th>
                    <th>Resolução</th>
                  </tr>
                </thead>
                <tbody>
                  {filtradas.slice(0, LIMITE_EXIBIDO).map((r, i) => {
                    const res = resolveDestinoAlocavel(r.destino, r.grupo, r.subCategoria);
                    return (
                      <tr key={`${r.origem}-${r.destino}-${i}`}>
                        <td>{r.origem}</td>
                        <td>{r.destino}</td>
                        <td className="fraco">{r.grupo} · {r.subCategoria}</td>
                        <td>
                          <span className={`badge ${r.fonte === 'seed' ? '' : 'info'}`}>
                            {r.fonte}
                          </span>
                        </td>
                        <td>
                          {res.ok ? (
                            <span
                              className="fraco"
                              title={`Resolvida por: ${res.conta.motivo} · linha ${res.conta.row} do template`}
                            >
                              {res.conta.motivo}
                              {res.conta.destino !== r.destino
                                ? ` → ${res.conta.destino}`
                                : ''}
                            </span>
                          ) : (
                            <span className="valor-erro" title={res.erro}>não resolve</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!filtradas.length ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="vazio">
                          Nenhuma regra com esses filtros. A conta provavelmente vai para o
                          julgamento por IA (ou para decisão manual na grade).
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="painel-corpo">
          <div className="fraco">
            A coluna <strong>Resolução</strong> mostra como a grafia da regra chega à posição
            canônica do template: <code>exato</code>, <code>alias</code>,
            {' '}<code>reescrita</code> (por exemplo &quot;L/P&quot; → &quot;LP&quot;) ou
            {' '}<code>nome-unico</code>. Na v1 a reescrita de &quot;L/P&quot; era código morto
            e ~138 regras de Passivo Não Circulante não resolviam: o valor virava chave órfã e
            desaparecia sem erro, produzindo o sintoma constante de
            {' '}<code>Ativo &gt; Passivo + PL</code>.
          </div>
        </div>
      </section>
    </>
  );
}
