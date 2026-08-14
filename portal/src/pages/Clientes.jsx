// CRUD de clientes.
//
// A tela é simples de propósito, mas o cliente é o que dá sentido à MEMÓRIA: a
// memória de alocação é por cliente, versionada, e é ela que evita refazer o
// mesmo trabalho manual a cada análise da mesma empresa. Por isso a lista mostra
// quantas regras já foram aprendidas - é o número que justifica o cadastro.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context/AppContext.jsx';
import {
  apagarCliente, carregarMemoria, listarAnalises, listarClientes, salvarCliente,
} from '../lib/repo.js';
import { data, inteiro } from '../lib/formato.js';

const VAZIO = { id: null, nome: '', cnpj: '', grupo: '', setor: '' };

export default function Clientes() {
  const { avisar } = useApp();
  const [clientes, setClientes] = useState([]);
  const [contagens, setContagens] = useState({});
  const [form, setForm] = useState(VAZIO);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [confirmar, setConfirmar] = useState(null);

  const recarregar = useCallback(async () => {
    setCarregando(true);
    try {
      const lista = await listarClientes();
      setClientes(lista);
      // As contagens são um EXTRA: se qualquer uma falhar, a lista continua útil.
      // Por isso `allSettled` e não `all`.
      const resultados = await Promise.allSettled(lista.map(async (c) => {
        const [mem, ans] = await Promise.all([
          carregarMemoria(c.id),
          listarAnalises({ clienteId: c.id }),
        ]);
        return [c.id, { memoria: mem.length, analises: ans.length }];
      }));
      setContagens(Object.fromEntries(
        resultados.filter((r) => r.status === 'fulfilled').map((r) => r.value),
      ));
    } catch (e) {
      avisar('erro', 'Não consegui listar os clientes.',
        e?.dica || 'Confira a URL de dados em Configurações.');
    } finally {
      setCarregando(false);
    }
  }, [avisar]);

  useEffect(() => { recarregar(); }, [recarregar]);

  const campo = (nome) => (e) => setForm((f) => ({ ...f, [nome]: e.target.value }));

  const enviar = async (e) => {
    e.preventDefault();
    setSalvando(true);
    try {
      await salvarCliente(form);
      avisar('ok', form.id ? 'Cliente atualizado.' : 'Cliente cadastrado.');
      setForm(VAZIO);
      await recarregar();
    } catch (err) {
      avisar('erro', err?.message || 'Não consegui salvar o cliente.', err?.dica || '');
    } finally {
      setSalvando(false);
    }
  };

  const remover = async (c) => {
    try {
      await apagarCliente(c.id);
      avisar('ok', `Cliente "${c.nome}" removido.`,
        'As análises dele foram desvinculadas, não apagadas: apagar o cadastro não pode '
        + 'destruir histórico já entregue. A memória, que é do cliente, foi removida.');
      setConfirmar(null);
      await recarregar();
    } catch (err) {
      avisar('erro', err?.message || 'Não consegui remover o cliente.', err?.dica || '');
    }
  };

  return (
    <>
      <div className="cabecalho-pagina">
        <div>
          <h1>Clientes</h1>
          <div className="subtitulo">
            Cada cliente carrega a própria memória de alocação, versionada. É ela que faz a
            segunda análise da mesma empresa custar uma fração da primeira.
          </div>
        </div>
      </div>

      <section className="painel">
        <div className="painel-cabecalho">
          <h2>{form.id ? 'Editar cliente' : 'Novo cliente'}</h2>
          {form.id ? (
            <button type="button" className="discreto" onClick={() => setForm(VAZIO)}>
              cancelar edição
            </button>
          ) : null}
        </div>
        <div className="painel-corpo">
          <form onSubmit={enviar}>
            <div className="campos-2">
              <div className="campo">
                <label htmlFor="cl-nome">Nome *</label>
                <input id="cl-nome" type="text" required value={form.nome} onChange={campo('nome')} />
              </div>
              <div className="campo">
                <label htmlFor="cl-cnpj">CNPJ</label>
                <input id="cl-cnpj" type="text" value={form.cnpj} onChange={campo('cnpj')} />
              </div>
              <div className="campo">
                <label htmlFor="cl-grupo">Grupo econômico</label>
                <input id="cl-grupo" type="text" value={form.grupo} onChange={campo('grupo')} />
              </div>
              <div className="campo">
                <label htmlFor="cl-setor">Setor</label>
                <input id="cl-setor" type="text" value={form.setor} onChange={campo('setor')} />
              </div>
            </div>
            <button type="submit" className="primario" disabled={salvando || !form.nome.trim()}>
              {salvando ? <span className="girando" /> : null}
              {form.id ? 'salvar alterações' : 'cadastrar'}
            </button>
          </form>
        </div>
      </section>

      <section className="painel">
        <div className="painel-cabecalho">
          <h2>Carteira</h2>
          <span className="fraco">{clientes.length} cliente(s)</span>
        </div>
        <div className="painel-corpo sem-espaco">
          {carregando ? (
            <div className="vazio"><span className="girando" /> carregando…</div>
          ) : !clientes.length ? (
            <div className="vazio">Nenhum cliente cadastrado.</div>
          ) : (
            <div className="tabela-envelope">
              <table className="tabela">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>CNPJ</th>
                    <th>Grupo</th>
                    <th>Setor</th>
                    <th className="num">Análises</th>
                    <th className="num">Regras na memória</th>
                    <th>Desde</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {clientes.map((c) => (
                    <tr key={c.id}>
                      <td>{c.nome}</td>
                      <td className="mono">{c.cnpj || ''}</td>
                      <td className="fraco">{c.grupo || ''}</td>
                      <td className="fraco">{c.setor || ''}</td>
                      <td className="num">{inteiro(contagens[c.id]?.analises ?? 0)}</td>
                      <td className="num">
                        {contagens[c.id]?.memoria
                          ? <span className="valor-ok">{inteiro(contagens[c.id].memoria)}</span>
                          : <span className="fraco">0</span>}
                      </td>
                      <td className="fraco nowrap">{data(c.criadoEm)}</td>
                      <td>
                        <div className="linha-botoes">
                          <Link className="botao pequeno" to="/analise">nova análise</Link>
                          <button type="button" className="pequeno" onClick={() => setForm({
                            id: c.id,
                            nome: c.nome ?? '',
                            cnpj: c.cnpj ?? '',
                            grupo: c.grupo ?? '',
                            setor: c.setor ?? '',
                          })}
                          >
                            editar
                          </button>
                          <button type="button" className="pequeno perigo" onClick={() => setConfirmar(c)}>
                            remover
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {confirmar ? (
        <div className="modal-fundo" role="dialog" aria-modal="true">
          <div className="modal" style={{ width: 'min(520px, 100%)' }}>
            <div className="modal-cabecalho">
              <h2>Remover {confirmar.nome}?</h2>
            </div>
            <div className="modal-corpo">
              <p>
                As <strong>análises continuam existindo</strong>, apenas desvinculadas - apagar
                o cadastro de um cliente não pode destruir histórico já entregue.
              </p>
              <p>
                A <strong>memória de alocação será removida</strong>: ela é do cliente e não faz
                sentido sem ele.
                {contagens[confirmar.id]?.memoria
                  ? ` São ${contagens[confirmar.id].memoria} regra(s) aprendidas que se perdem.`
                  : ''}
              </p>
            </div>
            <div className="modal-rodape">
              <button type="button" onClick={() => setConfirmar(null)}>cancelar</button>
              <button type="button" className="perigo" onClick={() => remover(confirmar)}>
                remover
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
