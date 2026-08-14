// SHADOW - as 79 posições alocáveis e os 28 subtotais, como o template as vê.
//
// Substitui os SUMIFS da planilha. Três coisas que a v1 não tinha e que estão
// visíveis aqui:
//
//  1. SUBTOTAL COM DESTAQUE. Subtotal é `kind:"calc"` e NÃO recebe alocação,
//     alocar nele descarta o valor. Distingui-los visualmente é o que impede o
//     analista de tentar. "Estoques" e "Disponibilidades" são subtotais e são os
//     destinos mais intuitivos que existem.
//
//  2. ORIGENS DE CADA POSIÇÃO. Clicar numa posição mostra QUAIS contas do
//     documento a compõem. Sem isso, "Outros Operacionais (AC) = 41.203.881,17"
//     é um número que o analista não tem como conferir.
//
//  3. RETIRAR UMA ORIGEM. E aqui há uma decisão de desenho que vale registrar:
//     retirar MUTA a linha (marca como contexto e liga `noAuto`), em vez de
//     lançar um ajuste. O template Excel tinha colunas Retirar/Adicionar que
//     permitiam somar um valor a uma linha SEM tirá-lo de outra - ou seja,
//     violavam a conservação de valor por construção, porque nada exigia o
//     Retirar antes do Adicionar. Mutar a linha mantém a conservação.
//     `noAuto: true` é o que impede o dicionário de realocar a conta no próximo
//     recálculo, desfazendo silenciosamente a decisão do analista.

import { useMemo, useState } from 'react';
import { blocosDaShadow, shadowLinhaTemValor, badgeDoBalanco } from '../lib/apresentacao.js';
import { moeda, percentual, rotuloAno, anosComDados } from '../lib/formato.js';

function BadgeBalanco({ balance, yearHeaders, indice }) {
  const b = badgeDoBalanco(balance);
  const classe = { fechado: 'ok', 'nao-encerrado': 'atencao', divergente: 'erro' }[b.estado] || '';
  return (
    <span
      className={`badge ${classe}`}
      title={`${b.detalhe}\n\nAtivo ${moeda(balance?.ativo)} · Passivo+PL ${moeda(balance?.passivoPl)}`}
    >
      <span className="ponto" />
      {rotuloAno(yearHeaders, indice)}: {b.texto}
      {b.estado === 'divergente'
        ? ` · dif ${moeda(b.dif)} (${percentual(b.difRelativa, 2)})`
        : ''}
      {b.estado === 'nao-encerrado' && b.transporte != null
        ? ` · transporte ${moeda(b.transporte)}`
        : ''}
    </span>
  );
}

/** Origens que compõem uma posição, com o botão de retirar. */
function Origens({ linha, rows, aoRetirar }) {
  const porId = useMemo(() => new Map((rows || []).map((r) => [r.id, r])), [rows]);
  const ids = linha.origemIds ?? [];
  if (!ids.length && !(linha.origens ?? []).length) {
    return <div className="vazio">Nenhuma conta do documento chegou a esta posição.</div>;
  }
  return (
    <div className="tabela-envelope">
      <table className="tabela">
        <thead>
          <tr>
            <th>Origem no documento</th>
            <th>Código</th>
            <th className="num">Ano 1</th>
            <th className="num">Ano 2</th>
            <th className="num">Ano 3</th>
            <th>Mapeado por</th>
            {aoRetirar ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {ids.map((id, i) => {
            const r = porId.get(id);
            const nome = r?.origem ?? linha.origens?.[i] ?? '(linha removida)';
            return (
              <tr key={`${id}-${i}`}>
                <td>{nome}</td>
                <td className="mono">{r?.codigo ?? ''}</td>
                <td className="num">{r ? moeda(r.ano1) : ''}</td>
                <td className="num">{r ? moeda(r.ano2) : ''}</td>
                <td className="num">{r ? moeda(r.ano3) : ''}</td>
                <td className="fraco">{r?.tipoMapeamento ?? ''}</td>
                {aoRetirar ? (
                  <td>
                    <button
                      type="button"
                      className="pequeno perigo"
                      disabled={!r || r._transporte}
                      title={r?._transporte
                        ? 'A linha de transporte é gerada pelo motor: desligue o transporte no painel de Qualidade.'
                        : 'Marca a linha como contexto e impede o dicionário de realocá-la'}
                      onClick={() => aoRetirar(id)}
                    >
                      retirar
                    </button>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {aoRetirar ? (
        <div className="fraco" style={{ padding: '8px 4px 0' }}>
          Retirar marca a linha como contexto e grava <code>noAuto</code>, para que nenhuma
          camada automática a realoque no próximo recálculo. A decisão negativa entra na
          memória do cliente - na v1 ela era descartada e o dicionário devolvia a conta ao
          mesmo lugar na análise seguinte.
        </div>
      ) : null}
    </div>
  );
}

function TabelaShadow({ linhas, rows, anos, aoRetirar, esconderZeradas }) {
  const [aberta, setAberta] = useState(null);
  const blocos = useMemo(() => blocosDaShadow(linhas), [linhas]);

  return (
    <div className="tabela-envelope alta">
      <table className="tabela">
        <thead>
          <tr>
            <th style={{ minWidth: 280 }}>Posição</th>
            <th>Tipo</th>
            {anos.map((a) => <th key={a.campo} className="num">{a.header}</th>)}
            <th className="num">Origens</th>
          </tr>
        </thead>
        <tbody>
          {/* `flatMap` porque cada bloco rende o cabeçalho de seção MAIS as suas
              linhas: array dentro de array viraria filho sem chave no React. */}
          {blocos.flatMap((bloco) => {
            const visiveis = esconderZeradas
              // Subtotal zerado também sai: um bloco inteiro vazio não ajuda.
              ? bloco.linhas.filter(shadowLinhaTemValor)
              : bloco.linhas;
            if (!visiveis.length) return [];
            return [
              <tr key={`sec-${bloco.rotulo}`} className="linha-secao">
                <td colSpan={3 + anos.length}>{bloco.rotulo}</td>
              </tr>,
              ...visiveis.flatMap((l) => {
                const chave = `${l.row}-${l.destino}`;
                const ehSubtotal = l.tipo === 'subtotal';
                const nOrigens = (l.origemIds ?? []).length;
                const clicavel = !ehSubtotal;
                const expandida = aberta === chave;
                return [
                  <tr
                    key={chave}
                    className={[
                      ehSubtotal ? 'linha-subtotal' : '',
                      clicavel ? 'clicavel' : '',
                      expandida ? 'linha-selecionada' : '',
                    ].filter(Boolean).join(' ')}
                    onClick={clicavel ? () => setAberta(expandida ? null : chave) : undefined}
                  >
                    <td>
                      <span className="fraco mono" style={{ marginRight: 6 }}>{l.row}</span>
                      {l.destino}
                    </td>
                    <td>
                      {ehSubtotal ? (
                        <span className="badge" title="Calculado por fórmula - não recebe alocação">
                          subtotal
                        </span>
                      ) : (
                        <span className="fraco">conta</span>
                      )}
                    </td>
                    {anos.map((a) => (
                      <td key={a.campo} className="num">{moeda(l[a.campo])}</td>
                    ))}
                    <td className="num">
                      {ehSubtotal ? '' : (
                        <span className={nOrigens ? '' : 'fraco'}>{nOrigens}</span>
                      )}
                    </td>
                  </tr>,
                  expandida ? (
                    <tr key={`${chave}-det`} className="trilha-detalhe">
                      <td colSpan={3 + anos.length}>
                        <Origens linha={l} rows={rows} aoRetirar={aoRetirar} />
                      </td>
                    </tr>
                  ) : null,
                ].filter(Boolean);
              }),
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * @param {{
 *   result: object,
 *   onRetirar?: (id:string)=>void
 * }} props
 */
export default function ShadowView({ result, onRetirar }) {
  const shadow = result?.shadow ?? null;
  const [aba, setAba] = useState('ap');
  const [esconderZeradas, setEsconderZeradas] = useState(true);
  const anos = useMemo(() => anosComDados(result?.yearHeaders), [result?.yearHeaders]);

  if (!shadow) {
    return (
      <section className="painel">
        <div className="painel-cabecalho"><h2>Shadow</h2></div>
        <div className="vazio">Sem alocação para agregar ainda.</div>
      </section>
    );
  }

  const orfaos = shadow.orphans ?? [];

  return (
    <section className="painel">
      {/* Cabeçalho fixo (sticky) com o badge do balanço: é o número que decide se
          a análise pode ser entregue, e ele não pode sair da tela enquanto o
          analista rola 107 posições. */}
      <div className="painel-cabecalho" style={{ position: 'sticky', top: 0, zIndex: 3 }}>
        <div>
          <h2>Shadow · 79 posições + 28 subtotais</h2>
          <div className="chips" style={{ marginTop: 4 }}>
            {anos.map((a) => (
              <BadgeBalanco
                key={a.campo}
                balance={shadow.balance?.[a.campo]}
                yearHeaders={result.yearHeaders}
                indice={a.indice}
              />
            ))}
            {!anos.length ? <span className="badge">nenhum período com dados</span> : null}
          </div>
        </div>
        <div className="linha-botoes">
          <button
            type="button"
            className={aba === 'ap' ? 'primario' : ''}
            onClick={() => setAba('ap')}
          >
            Ativo / Passivo
          </button>
          <button
            type="button"
            className={aba === 'dre' ? 'primario' : ''}
            onClick={() => setAba('dre')}
          >
            DRE
          </button>
        </div>
      </div>

      <div className="painel-corpo">
        <label className="caixa-marcavel">
          <input
            type="checkbox"
            checked={esconderZeradas}
            onChange={(e) => setEsconderZeradas(e.target.checked)}
          />
          <span>
            Esconder posições zeradas
            <span className="fraco">
              {' '} - num balanço típico ~15 das 107 linhas têm valor; mostrar todas afoga o que importa
            </span>
          </span>
        </label>

        {orfaos.length ? (
          <div className="aviso erro">
            <div className="aviso-titulo">
              {orfaos.length} chave(s) órfã(s): valor alocado que não entra em nenhuma linha
              do template.
            </div>
            <ul className="lista-simples">
              {orfaos.slice(0, 8).map((o) => (
                <li key={o.chave}>
                  <strong>{o.destino}</strong> ({o.grupo}/{o.subCategoria}){' '}
                  {moeda(o.ano3 || o.ano2 || o.ano1)} - origens: {o.origens.slice(0, 3).join(', ')}
                  {o.origens.length > 3 ? '…' : ''}
                </li>
              ))}
            </ul>
            <div className="aviso-dica">
              Escolha um destino válido para essas contas na grade. O seletor de destino só
              oferece posições que existem no bloco compatível, então basta trocar por ele.
            </div>
          </div>
        ) : null}

        <TabelaShadow
          linhas={aba === 'ap' ? shadow.ativoPassivo : shadow.dre}
          rows={result.rows}
          anos={anos}
          aoRetirar={onRetirar}
          esconderZeradas={esconderZeradas}
        />

        {/* Receitas e despesas são INFORMATIVAS: o resultado que vale vem da
            linha 35 do próprio template, e não de uma segunda soma paralela,
            duas implementações do resultado é ter duas verdades capazes de
            divergir. */}
        <div className="grade-cartoes" style={{ marginTop: 14, marginBottom: 0 }}>
          {anos.map((a) => {
            const b = shadow.balance?.[a.campo];
            if (!b) return null;
            return (
              <div className="cartao" key={a.campo}>
                <div className="rotulo">{a.header}</div>
                <table className="tabela" style={{ fontSize: 12.5 }}>
                  <tbody>
                    <tr><td>Ativo</td><td className="num">{moeda(b.ativo)}</td></tr>
                    <tr><td>Passivo + PL</td><td className="num">{moeda(b.passivoPl)}</td></tr>
                    <tr>
                      <td>Diferença</td>
                      <td className={`num ${b.fecha ? 'valor-ok' : 'valor-erro'}`}>
                        {moeda(b.dif)}
                      </td>
                    </tr>
                    <tr>
                      <td>Resultado (linha 35)</td>
                      <td className="num">{moeda(b.resultado)}</td>
                    </tr>
                    <tr>
                      <td>Resíduo da estendida</td>
                      <td className={`num ${b.fechaEstendida ? 'valor-ok' : 'valor-erro'}`}>
                        {moeda(b.difEstendida)}
                      </td>
                    </tr>
                    <tr>
                      <td className="fraco">Tolerância</td>
                      <td className="num fraco">{moeda(b.tolerancia)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
