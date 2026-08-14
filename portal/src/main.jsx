import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
import { AppProvider } from './context/AppContext.jsx';
import './styles/global.css';

// HashRouter, não BrowserRouter.
//
// O GitHub Pages é hospedagem ESTÁTICA: não há como configurar "sirva
// index.html para qualquer caminho". Com `BrowserRouter`, a rota
// `/ALLocator-v2/analise/42` é uma URL de servidor - funciona ao navegar por
// links (o React Router intercepta o clique) e devolve 404 ao apertar F5 ou
// colar o link. É o tipo de falha que só aparece na frente de outra pessoa.
//
// O que vem depois do `#` nunca é enviado ao servidor: é fragmento, tratado
// inteiramente no cliente. Recarregar, colar link e usar o botão voltar
// funcionam. Existe o truque de copiar `index.html` para `404.html`, mas ele
// devolve HTTP 404 no primeiro byte - ruim para cache e estranho de explicar.
createRoot(document.getElementById('raiz')).render(
  <StrictMode>
    <HashRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </HashRouter>
  </StrictMode>,
);
