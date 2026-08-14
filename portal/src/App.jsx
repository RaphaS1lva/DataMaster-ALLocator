// Rotas do portal.
//
// Login é a única rota fora do Layout - não faz sentido mostrar barra lateral e
// Configurações a quem ainda não entrou.
//
// `Analise` aceita duas rotas para a MESMA tela: `/analise` (nova) e
// `/analise/:id` (abrir salva). A `key` no elemento força remontagem ao trocar
// de id: sem ela, o React reaproveitaria a instância e as linhas da análise
// anterior sobreviveriam na tela da nova - com o pipeline recalculando sobre
// dado de outro cliente.

import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Clientes from './pages/Clientes.jsx';
import Analise from './pages/Analise.jsx';
import Dicionario from './pages/Dicionario.jsx';
import { useApp } from './context/AppContext.jsx';

function AnaliseComChave() {
  const { id } = useParams();
  return <Analise key={id ?? 'nova'} analiseId={id ?? null} />;
}

/** Rota que exige sessão. Sem sessão, manda ao login. */
function Protegida({ children }) {
  const { sessao, carregandoConfig } = useApp();
  // Espera a configuração antes de decidir: `modoLocal()` depende dela, e
  // redirecionar para o login antes de saber se há servidor faria a tela piscar.
  if (carregandoConfig) {
    return (
      <div className="tela-login">
        <span className="girando" aria-label="carregando" />
      </div>
    );
  }
  if (!sessao) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={(
          <Protegida>
            <Layout />
          </Protegida>
        )}
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/clientes" element={<Clientes />} />
        <Route path="/analise" element={<AnaliseComChave />} />
        <Route path="/analise/:id" element={<AnaliseComChave />} />
        <Route path="/dicionario" element={<Dicionario />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
