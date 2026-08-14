// Estado global do portal: configuração em runtime, sessão, tema e avisos.
//
// Por que Context e não uma biblioteca de estado: o que é global aqui são quatro
// coisas pequenas e de escrita rara. O estado que muda a toda tecla - as linhas
// da análise - é LOCAL da página `Analise`, de propósito: o pipeline recalcula
// por `useMemo` sobre elas, e pôr isso num store global só adicionaria
// re-render em telas que não têm nada a ver com a análise.
//
// O que NÃO está aqui, e é a decisão central da página de análise: o RESULTADO
// do pipeline. Ele é sempre derivado (`useMemo`), nunca guardado. Resultado
// guardado é resultado que pode ficar velho - e um balanço velho na tela é pior
// do que nenhum balanço.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { carregarConfig, getConfig, salvarConfig, limparConfig } from '../lib/config.js';
import { sessaoAtual, entrar as entrarRepo, sair as sairRepo, modoLocal } from '../lib/repo.js';

const CHAVE_TEMA = 'allocator:tema';

const Ctx = createContext(null);

/** @returns {ReturnType<typeof useValorApp>} */
export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp fora de <AppProvider>');
  return v;
}

function lerTema() {
  try {
    const t = globalThis.localStorage?.getItem(CHAVE_TEMA);
    if (t === 'claro' || t === 'escuro') return t;
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'escuro' : 'claro';
  } catch {
    return 'claro';
  }
}

function useValorApp() {
  const [config, setConfig] = useState(() => getConfig());
  const [carregandoConfig, setCarregandoConfig] = useState(true);
  const [sessao, setSessao] = useState(() => sessaoAtual());
  const [tema, setTema] = useState(lerTema);
  const [avisos, setAvisos] = useState([]);
  const proximoAviso = useRef(0);

  // A configuração é lida UMA vez no boot. Enquanto isso a UI mostra "carregando"
  // em vez de renderizar com URL vazia e disparar erros de rede inúteis.
  useEffect(() => {
    let vivo = true;
    carregarConfig()
      .then((c) => { if (vivo) setConfig(c); })
      .finally(() => { if (vivo) setCarregandoConfig(false); });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.tema = tema;
    try {
      globalThis.localStorage?.setItem(CHAVE_TEMA, tema);
    } catch { /* preferência de tema não vale um erro na tela */ }
  }, [tema]);

  const alternarTema = useCallback(() => {
    setTema((t) => (t === 'escuro' ? 'claro' : 'escuro'));
  }, []);

  /**
   * Aviso transitório no topo da tela.
   * @param {'ok'|'erro'|'atencao'|'info'} tipo
   * @param {string} texto o que aconteceu
   * @param {string} [dica] o que fazer - mensagem sem dica é só reclamação
   */
  const avisar = useCallback((tipo, texto, dica = '') => {
    proximoAviso.current += 1;
    const id = proximoAviso.current;
    setAvisos((lista) => [...lista, { id, tipo, texto, dica }]);
    // Erro NÃO desaparece sozinho: o usuário precisa ler e decidir. Sucesso sai
    // em 6s porque manter confirmação na tela vira ruído.
    if (tipo !== 'erro') {
      setTimeout(() => {
        setAvisos((lista) => lista.filter((a) => a.id !== id));
      }, 6000);
    }
    return id;
  }, []);

  const fecharAviso = useCallback((id) => {
    setAvisos((lista) => lista.filter((a) => a.id !== id));
  }, []);

  const aplicarConfig = useCallback(async (parcial) => {
    const nova = salvarConfig(parcial);
    setConfig({ ...nova });
    return nova;
  }, []);

  const restaurarConfig = useCallback(async () => {
    const nova = await limparConfig();
    setConfig({ ...nova });
    return nova;
  }, []);

  const recarregarConfig = useCallback(async () => {
    const nova = await carregarConfig();
    setConfig({ ...nova });
    return nova;
  }, []);

  const entrar = useCallback(async (email, senha) => {
    const s = await entrarRepo(email, senha);
    setSessao(s);
    return s;
  }, []);

  const sair = useCallback(() => {
    sairRepo();
    setSessao(null);
  }, []);

  return useMemo(() => ({
    config,
    carregandoConfig,
    aplicarConfig,
    restaurarConfig,
    recarregarConfig,
    // `local` é exibido de forma permanente na UI. Esconder de quem opera que o
    // dado está só no navegador seria mentir sobre onde ele está.
    local: modoLocal(),
    sessao,
    entrar,
    sair,
    tema,
    alternarTema,
    avisos,
    avisar,
    fecharAviso,
  }), [config, carregandoConfig, aplicarConfig, restaurarConfig, recarregarConfig,
    sessao, entrar, sair, tema, alternarTema, avisos, avisar, fecharAviso]);
}

export function AppProvider({ children }) {
  const valor = useValorApp();
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}
