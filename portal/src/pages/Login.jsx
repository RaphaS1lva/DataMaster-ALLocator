// Login contra `/dados/auth/login`.
//
// O modo local entra DIRETO, com aviso visível. Duas razões:
//
//  · sem plano de dados não existe usuário para autenticar - exigir senha seria
//    teatro de segurança, porque não há nada do outro lado para validá-la;
//  · o portal precisa ser demonstrável offline, e uma tela de login que não
//    passa é a pior forma de descobrir que o servidor está fora.
//
// O aviso é permanente e explícito: o dado fica no navegador. Esconder isso de
// quem opera seria mentir sobre onde o balanço do cliente está guardado.

import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import { ErroApi } from '../lib/api.js';

export default function Login() {
  const { sessao, entrar, local, carregandoConfig, config, tema, alternarTema } = useApp();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const navegar = useNavigate();

  useEffect(() => { setErro(null); }, [local]);

  if (sessao) return <Navigate to="/" replace />;

  const enviar = async (e) => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await entrar(email.trim(), senha);
      navegar('/', { replace: true });
    } catch (err) {
      setErro(err instanceof ErroApi
        ? { texto: err.message, dica: err.dica }
        : { texto: String(err?.message || err), dica: '' });
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="tela-login">
      <div className="caixa-login">
        <div className="painel">
          <div className="painel-cabecalho">
            <div>
              <h1>ALLocator v2</h1>
              <div className="fraco">
                Alocação de demonstrações financeiras com a identidade contábil verificada
                por construção, não conferida no fim.
              </div>
            </div>
            <button type="button" className="discreto pequeno" onClick={alternarTema}>
              {tema === 'escuro' ? 'claro' : 'escuro'}
            </button>
          </div>

          <div className="painel-corpo">
            {carregandoConfig ? (
              <div className="vazio"><span className="girando" /> lendo a configuração…</div>
            ) : local ? (
              <>
                <div className="aviso atencao destaque">
                  <div className="aviso-titulo">Modo local, sem servidor</div>
                  Nenhuma URL de dados está configurada. Clientes, análises e memória ficam
                  apenas no <code>localStorage</code> deste navegador - não há backup, não
                  há compartilhamento, e limpar os dados do site apaga tudo.
                  <div className="aviso-dica">
                    O pipeline contábil roda inteiro no navegador, então a trilha de valor, o
                    painel de QA e a Shadow funcionam igual. Para persistir no servidor,
                    preencha a URL de dados em Configurações depois de entrar.
                  </div>
                </div>
                <form onSubmit={enviar}>
                  <div className="campo">
                    <label htmlFor="lg-email">Identificação (opcional)</label>
                    <input
                      id="lg-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="seu.email@empresa.com"
                      autoComplete="username"
                    />
                    <div className="ajuda">
                      Só rotula a sessão local. Não é validada porque não há servidor para
                      validá-la.
                    </div>
                  </div>
                  <button type="submit" className="primario" disabled={enviando}>
                    {enviando ? <span className="girando" /> : null}
                    Entrar no modo local
                  </button>
                </form>
              </>
            ) : (
              <form onSubmit={enviar}>
                <div className="campo">
                  <label htmlFor="lg-email">E-mail</label>
                  <input
                    id="lg-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="username"
                  />
                </div>
                <div className="campo">
                  <label htmlFor="lg-senha">Senha</label>
                  <input
                    id="lg-senha"
                    type="password"
                    required
                    value={senha}
                    onChange={(e) => setSenha(e.target.value)}
                    autoComplete="current-password"
                  />
                </div>
                {erro ? (
                  <div className="aviso erro">
                    <div className="aviso-titulo">{erro.texto}</div>
                    {erro.dica ? <div className="aviso-dica">{erro.dica}</div> : null}
                  </div>
                ) : null}
                <button type="submit" className="primario" disabled={enviando}>
                  {enviando ? <span className="girando" /> : null}
                  Entrar
                </button>
                <div className="fraco" style={{ marginTop: 10 }}>
                  Autenticando em <code>{config.apiDados}</code>. O primeiro acesso após
                  ociosidade pode demorar ~50s (cold start do plano gratuito) - não é falha.
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
