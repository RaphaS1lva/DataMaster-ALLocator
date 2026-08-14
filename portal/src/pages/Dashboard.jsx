// Painel inicial: contagens, últimas análises e o estado da IA.
//
// O cartão de saúde da IA existe por uma razão de expectativa: o plano de
// inferência roda num notebook com GPU atrás de um tunnel, e portanto ESTÁ FORA
// boa parte do tempo. Se o portal só dissesse "erro", o operador concluiria que
// o sistema quebrou. A mensagem tem de dizer a coisa certa: a IA está fora, o
// modo determinístico continua funcionando, e o que está indisponível é o
// julgamento automático - não a análise.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import { health, ErroApi } from '../lib/api.js';
import { listarAnalises, listarClientes, modoLocal } from '../lib/repo.js';
import { DICIONARIO_SEED } from '../core/data/dicionario.gen.js';
import { dataHora, inteiro } from '../lib/formato.js';

/** Cartão de saúde do plano de inferência. Falha aqui é informação, não erro. */
function SaudeIA() {
  const { config } = useApp();
  const [estado, setEstado] = useState({ fase: 'carregando' });

  const consultar = useCallback(() => {
    if (!config.apiInferencia) {
      setEstado({ fase: 'nao-configurado' });
      return;
    }
    setEstado({ fase: 'carregando' });
    health()
      .then((h) => setEstado({ fase: 'ok', h }))
      .catch((e) => setEstado({
        fase: 'fora',
        texto: e instanceof ErroApi ? e.message : String(e?.message || e),
        dica: e instanceof ErroApi ? e.dica : '',
      }));
  }, [config.apiInferencia]);

  useEffect(consultar, [consultar]);

  const modelos = useMemo(() => {
    const escada = estado.h?.provedores?.escada;
    if (!escada) return [];
    return Object.entries(escada).flatMap(([tipo, itens]) => (itens || []).map((m) => ({
      tipo, nome: m.nome, instalado: m.instalado, disponivel: m.disponivel, nota: m.nota,
    })));
  }, [estado.h]);

  return (
    <section className="painel">
      <div className="painel-cabecalho">
        <div>
          <h2>Saúde da IA</h2>
          <div className="fraco">Plano de inferência: leitura de documento, julgamento e parecer.</div>
        </div>
        <div className="linha-botoes">
          {estado.fase === 'ok' ? (
            <span className="badge ok"><span className="ponto" />no ar</span>
          ) : estado.fase === 'carregando' ? (
            <span className="badge"><span className="girando" /> consultando</span>
          ) : (
            <span className="badge atencao"><span className="ponto" />indisponível</span>
          )}
          <button type="button" className="pequeno" onClick={consultar}>reconsultar</button>
        </div>
      </div>

      <div className="painel-corpo">
        {estado.fase === 'nao-configurado' ? (
          <div className="aviso atencao">
            <div className="aviso-titulo">Nenhuma URL de inferência configurada.</div>
            <div className="aviso-dica">
              O <strong>modo determinístico continua funcionando por inteiro</strong>: leitura
              manual ou colada, hierarquia, regra de sinal, dicionário de {inteiro(DICIONARIO_SEED.length)} regras,
              memória do cliente, trilha de valor, QA e fechamento. O que falta é a leitura
              automática de PDF e o julgamento das contas que o dicionário não conhece.
              Preencha a URL em Configurações.
            </div>
          </div>
        ) : null}

        {estado.fase === 'fora' ? (
          <div className="aviso atencao">
            <div className="aviso-titulo">A inferência não respondeu: {estado.texto}</div>
            <div className="aviso-dica">
              {estado.dica}
              {' '}
              <strong>Isto não impede a análise.</strong> O pipeline contábil roda no
              navegador e é o que garante o fechamento; a IA só faz o julgamento semântico
              das contas desconhecidas, que você pode fazer à mão na grade. Se o notebook de
              inferência foi reiniciado, o hostname do tunnel mudou - cole o novo em
              Configurações.
            </div>
          </div>
        ) : null}

        {estado.fase === 'ok' ? (
          <>
            <div className="chips" style={{ marginBottom: 10 }}>
              <span className="badge info">prompts {estado.h.prompt_version ?? '?'}</span>
              <span className={`badge ${estado.h.autenticacao ? 'ok' : 'atencao'}`}>
                {estado.h.autenticacao ? 'autenticada' : 'SEM autenticação'}
              </span>
              <span className={`badge ${estado.h.banco_configurado ? 'ok' : ''}`}>
                banco {estado.h.banco_configurado ? 'configurado' : 'não configurado'}
              </span>
              <span className="badge">upload até {estado.h.max_upload_mb ?? '?'} MB</span>
              <span className={`badge ${estado.h.provedores?.ollama?.ativo ? 'ok' : 'atencao'}`}>
                Ollama local {estado.h.provedores?.ollama?.ativo ? 'ativo' : 'inativo'}
              </span>
            </div>

            {!estado.h.provedores?.deps && estado.h.provedores?.deps !== undefined ? (
              <div className="aviso atencao">
                <div className="aviso-titulo">
                  Este servidor subiu sem a camada de LLM (dependências ausentes).
                </div>
                <div className="aviso-dica">
                  Ele ainda faz a leitura determinística de documento, que é 0 token. O
                  julgamento e o parecer ficam indisponíveis.
                </div>
              </div>
            ) : null}

            {modelos.length ? (
              <div className="tabela-envelope">
                <table className="tabela">
                  <thead>
                    <tr>
                      <th>Modelo</th><th>Uso</th><th>Instalado</th><th>Disponível</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelos.map((m) => (
                      <tr key={`${m.tipo}-${m.nome}`}>
                        <td className="mono" title={m.nota}>{m.nome}</td>
                        <td className="fraco">{m.tipo}</td>
                        <td>{m.instalado ? 'sim' : <span className="fraco">não</span>}</td>
                        <td>
                          {m.disponivel
                            ? <span className="badge ok">pronto</span>
                            : <span className="fraco"> - </span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="fraco" style={{ paddingTop: 6 }}>
                  A cascata tenta do modelo mais capaz para o mais leve e cai para a nuvem só
                  se nada local responder. Como o julgamento recebe ~9 a 15 candidatos (e não
                  as 79 posições), o degrau de baixo já resolve a maior parte dos casos.
                </div>
              </div>
            ) : (
              <div className="fraco">O servidor não informou a escada de modelos.</div>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

export default function Dashboard() {
  const { avisar, local } = useApp();
  const [analises, setAnalises] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let vivo = true;
    Promise.all([listarAnalises({ limite: 12 }), listarClientes()])
      .then(([a, c]) => {
        if (!vivo) return;
        setAnalises(a);
        setClientes(c);
      })
      .catch((e) => {
        if (!vivo) return;
        avisar('erro', 'Não consegui carregar o histórico.',
          e?.dica || 'Confira a URL de dados em Configurações. O modo local guarda tudo no navegador.');
      })
      .finally(() => { if (vivo) setCarregando(false); });
    return () => { vivo = false; };
  }, [avisar]);

  const conciliadas = analises.filter((a) => a.balancoFechado || a.conciliado).length;

  return (
    <>
      <div className="cabecalho-pagina">
        <div>
          <h1>Painel</h1>
          <div className="subtitulo">
            O pipeline contábil roda no navegador: recalcula a cada edição e funciona com o
            servidor fora do ar. O que o servidor faz é ler documento, julgar conta
            desconhecida e persistir.
          </div>
        </div>
        <Link className="botao primario" to="/analise">Nova análise</Link>
      </div>

      {local ? (
        <div className="aviso atencao">
          <div className="aviso-titulo">Modo local: os dados estão só neste navegador.</div>
          <div className="aviso-dica">
            Bom para demonstração e desenvolvimento. Para persistir de verdade, preencha a
            URL de dados em Configurações.
          </div>
        </div>
      ) : null}

      <div className="grade-cartoes">
        <div className="cartao">
          <div className="rotulo">Análises</div>
          <div className="valor">{carregando ? ' - ' : inteiro(analises.length)}</div>
          <div className="nota">últimas carregadas</div>
        </div>
        <div className="cartao">
          <div className="rotulo">Balanços conciliados</div>
          <div className={`valor ${conciliadas ? 'valor-ok' : ''}`}>
            {carregando ? ' - ' : inteiro(conciliadas)}
          </div>
          <div className="nota">
            {analises.length ? `de ${analises.length} · A = P + PL fechando` : 'nenhuma análise ainda'}
          </div>
        </div>
        <div className="cartao">
          <div className="rotulo">Clientes</div>
          <div className="valor">{carregando ? ' - ' : inteiro(clientes.length)}</div>
          <div className="nota">com memória própria de alocação</div>
        </div>
        <div className="cartao">
          <div className="rotulo">Regras no dicionário</div>
          <div className="valor">{inteiro(DICIONARIO_SEED.length)}</div>
          <div className="nota">curadas, todas resolvendo para conta alocável</div>
        </div>
      </div>

      <section className="painel">
        <div className="painel-cabecalho">
          <h2>Últimas análises</h2>
          <span className="fraco">as 12 mais recentes</span>
        </div>
        <div className="painel-corpo sem-espaco">
          {carregando ? (
            <div className="vazio"><span className="girando" /> carregando…</div>
          ) : !analises.length ? (
            <div className="vazio">
              Nenhuma análise ainda. Comece por <Link to="/analise">Nova análise</Link>.
            </div>
          ) : (
            <div className="tabela-envelope">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Empresa</th>
                    <th>Períodos</th>
                    <th className="num">Linhas</th>
                    <th>Status</th>
                    <th>Balanço</th>
                    <th>Atualizada</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {analises.map((a) => (
                    <tr key={a.id}>
                      <td>{a.empresa || <span className="fraco">(sem nome)</span>}</td>
                      <td className="fraco">{(a.periodos ?? []).join(' · ') || ' - '}</td>
                      <td className="num">{inteiro(a.nLinhas ?? 0)}</td>
                      <td><span className="badge">{a.status}</span></td>
                      <td>
                        {a.balancoFechado
                          ? <span className="badge ok"><span className="ponto" />fecha</span>
                          : <span className="badge atencao"><span className="ponto" />não fecha</span>}
                      </td>
                      <td className="fraco nowrap">{dataHora(a.atualizadoEm)}</td>
                      <td><Link className="botao pequeno" to={`/analise/${a.id}`}>abrir</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <SaudeIA />
    </>
  );
}
