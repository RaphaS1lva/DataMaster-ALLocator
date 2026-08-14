// Casca do portal: barra lateral, tema, avisos e a tela de Configurações.
//
// A tela de Configurações é o par indispensável da configuração em runtime: sem
// um lugar para editar as URLs, "ler em runtime" não resolveria nada - o valor
// continuaria vindo de um arquivo que só um deploy troca. Ela também TESTA a
// conexão ali mesmo, porque o erro mais comum não é a URL estar errada e sim o
// servidor estar fora do ar, e distinguir os dois casos sem sair da tela é o que
// evita meia hora de diagnóstico.

import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import { health, ErroApi } from '../lib/api.js';
import { modoLocal } from '../lib/repo.js';

const NAVEGACAO = [
  { para: '/', rotulo: 'Painel', fim: true },
  { para: '/analise', rotulo: 'Nova análise' },
  { para: '/clientes', rotulo: 'Clientes' },
  { para: '/dicionario', rotulo: 'Dicionário' },
];

/** Barra de avisos do topo. Erro não sai sozinho; o resto sai em 6s. */
function Avisos() {
  const { avisos, fecharAviso } = useApp();
  if (!avisos.length) return null;
  return (
    <div className="pilha" style={{ marginBottom: 12 }}>
      {avisos.map((a) => (
        <div key={a.id} className={`aviso ${a.tipo}`} role={a.tipo === 'erro' ? 'alert' : 'status'}>
          <div className="linha-botoes">
            <div style={{ flex: '1 1 auto' }}>
              <div className="aviso-titulo">{a.texto}</div>
              {a.dica ? <div className="aviso-dica">{a.dica}</div> : null}
            </div>
            <button type="button" className="discreto pequeno" onClick={() => fecharAviso(a.id)}>
              fechar
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Painel de Configurações.
 *
 * Os campos são exatamente os do `runtime-config.json`. O que é gravado aqui vai
 * para `localStorage` e tem PRECEDÊNCIA sobre o arquivo publicado - é o caminho
 * de correção rápida quando o hostname do tunnel muda. "Restaurar" apaga o
 * override e volta ao arquivo.
 */
function Configuracoes({ aoFechar }) {
  const { config, aplicarConfig, restaurarConfig, recarregarConfig, avisar } = useApp();
  const [form, setForm] = useState({
    apiDados: config.apiDados || '',
    apiInferencia: config.apiInferencia || '',
    tokenApi: config.tokenApi || '',
  });
  const [testando, setTestando] = useState(false);
  const [estadoConexao, setEstadoConexao] = useState(null);

  useEffect(() => {
    setForm({
      apiDados: config.apiDados || '',
      apiInferencia: config.apiInferencia || '',
      tokenApi: config.tokenApi || '',
    });
  }, [config]);

  const campo = (nome) => (e) => setForm((f) => ({ ...f, [nome]: e.target.value }));

  const salvar = async () => {
    await aplicarConfig(form);
    avisar('ok', 'Configuração salva neste navegador.',
      'Vale imediatamente, sem recarregar. Para valer para todos, edite '
      + 'portal/public/runtime-config.json e publique.');
  };

  const testar = async () => {
    setTestando(true);
    setEstadoConexao(null);
    try {
      // Salva antes de testar: testar um valor que não está em vigor daria um
      // resultado que não corresponde ao que o portal vai usar.
      await aplicarConfig(form);
      const h = await health();
      setEstadoConexao({
        ok: true,
        texto: `Inferência no ar · prompts ${h.prompt_version ?? '?'}`
          + `${h.autenticacao ? ' · autenticada' : ' · SEM autenticação'}`
          + `${h.banco_configurado ? ' · banco configurado' : ' · banco não configurado'}`,
      });
    } catch (e) {
      setEstadoConexao({
        ok: false,
        texto: e instanceof ErroApi ? e.message : String(e?.message || e),
        dica: e instanceof ErroApi ? e.dica : '',
      });
    } finally {
      setTestando(false);
    }
  };

  return (
    <div className="modal-fundo" role="dialog" aria-modal="true" aria-label="Configurações">
      <div className="modal">
        <div className="modal-cabecalho">
          <div>
            <h2>Configurações</h2>
            <div className="fraco">
              As URLs são lidas em runtime, não da build. O que você põe aqui fica
              neste navegador e tem precedência sobre o runtime-config.json publicado.
            </div>
          </div>
          <button type="button" className="discreto" onClick={aoFechar}>fechar</button>
        </div>

        <div className="modal-corpo">
          <div className="aviso info">
            <div className="aviso-titulo">Por que editar aqui e não na build</div>
            O hostname do Cloudflare Tunnel gratuito muda a cada reinício do processo.
            Com a URL embutida na build seria preciso rebuild, commit, push e esperar o
            deploy a cada mudança - dois a cinco minutos. Aqui são cinco segundos, sem
            rede e sem CI.
          </div>

          <div className="campo">
            <label htmlFor="cfg-dados">URL do plano de DADOS (CRUD, memória, login)</label>
            <input
              id="cfg-dados"
              type="text"
              value={form.apiDados}
              onChange={campo('apiDados')}
              placeholder="https://allocator-api.onrender.com"
              spellCheck={false}
            />
            <div className="ajuda">
              Vazio = modo local: clientes, análises e memória ficam no localStorage
              deste navegador. O portal fica demonstrável sem servidor.
            </div>
          </div>

          <div className="campo">
            <label htmlFor="cfg-inf">URL do plano de INFERÊNCIA (leitura, julgamento, parecer)</label>
            <input
              id="cfg-inf"
              type="text"
              value={form.apiInferencia}
              onChange={campo('apiInferencia')}
              placeholder="https://quatro-palavras-aleatorias.trycloudflare.com"
              spellCheck={false}
            />
            <div className="ajuda">
              Vazio = modo determinístico: sem leitura automática de documento e sem
              julgamento por IA. Dicionário, memória, edição manual e todo o pipeline
              contábil continuam funcionando.
            </div>
          </div>

          <div className="campo">
            <label htmlFor="cfg-token">Token da API (Bearer compartilhado)</label>
            <input
              id="cfg-token"
              type="password"
              value={form.tokenApi}
              onChange={campo('tokenApi')}
              placeholder="deixe vazio se a API roda aberta"
              spellCheck={false}
            />
            <div className="ajuda">
              Corresponde a ALLOCATOR_API_TOKEN no servidor. Sem ele a API roda aberta,
              o que em dev é aceitável e em produção não.
            </div>
          </div>

          <div className="fraco" style={{ marginBottom: 10 }}>
            Origem do valor em uso: <strong>{config.fonte}</strong>
            {' · '}
            versão declarada: <strong>{config.versao || ' - '}</strong>
          </div>

          {estadoConexao ? (
            <div className={`aviso ${estadoConexao.ok ? 'ok' : 'erro'}`}>
              <div className="aviso-titulo">{estadoConexao.texto}</div>
              {estadoConexao.dica ? <div className="aviso-dica">{estadoConexao.dica}</div> : null}
            </div>
          ) : null}
        </div>

        <div className="modal-rodape">
          <button
            type="button"
            className="discreto"
            onClick={async () => {
              await restaurarConfig();
              avisar('ok', 'Override removido.', 'O portal voltou ao runtime-config.json publicado.');
            }}
          >
            restaurar publicado
          </button>
          <button type="button" className="discreto" onClick={() => recarregarConfig()}>
            recarregar arquivo
          </button>
          <span className="espaco" />
          <button type="button" onClick={testar} disabled={testando || !form.apiInferencia}>
            {testando ? <span className="girando" /> : null}
            testar inferência
          </button>
          <button type="button" className="primario" onClick={salvar}>salvar</button>
        </div>
      </div>
    </div>
  );
}

export default function Layout() {
  const { sessao, sair, tema, alternarTema } = useApp();
  const [abrirConfig, setAbrirConfig] = useState(false);
  const navegar = useNavigate();
  const local = modoLocal();

  const sairEIr = useCallback(() => {
    sair();
    navegar('/login', { replace: true });
  }, [sair, navegar]);

  return (
    <div className="app">
      <nav className="barra" aria-label="Navegação principal">
        <div className="barra-marca">
          <strong>ALLocator</strong>
          <span>v2 · invariante contábil verificada</span>
        </div>

        {NAVEGACAO.map((n) => (
          <NavLink
            key={n.para}
            to={n.para}
            end={n.fim}
            className={({ isActive }) => `barra-item${isActive ? ' ativo' : ''}`}
          >
            {n.rotulo}
          </NavLink>
        ))}

        <div className="barra-rodape">
          {local ? (
            <div className="badge atencao" style={{ marginBottom: 8 }} title="Nenhuma URL de dados configurada">
              <span className="ponto" />
              modo local
            </div>
          ) : null}
          <button type="button" className="barra-item" onClick={() => setAbrirConfig(true)}>
            Configurações
          </button>
          <button type="button" className="barra-item" onClick={alternarTema}>
            Tema: {tema === 'escuro' ? 'escuro' : 'claro'}
          </button>
          <button type="button" className="barra-item" onClick={sairEIr}>
            Sair{sessao?.usuario?.email ? ` (${sessao.usuario.email})` : ''}
          </button>
        </div>
      </nav>

      <main className="conteudo">
        <div className="conteudo-largo">
          <Avisos />
          <Outlet />
        </div>
      </main>

      {abrirConfig ? <Configuracoes aoFechar={() => setAbrirConfig(false)} /> : null}
    </div>
  );
}
