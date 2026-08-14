// Invariantes contábeis. Este módulo é a razão de existir do v2.
//
// ---------------------------------------------------------------------------
// A TESE
// ---------------------------------------------------------------------------
// `Ativo = Passivo + PL` não deve ser uma ESPERANÇA verificada no fim; deve ser
// uma CONSEQUÊNCIA de duas propriedades verificáveis:
//
//   (1) o documento de origem fecha consigo mesmo, e
//   (2) a alocação é uma função TOTAL das folhas para as 79 posições, sem
//       perda e sem duplicata.
//
// Se (1) e (2) valem, o balanço alocado fecha necessariamente - porque a
// alocação é apenas uma reetiquetagem de uma partição das folhas. Logo, quando
// não fecha, a falha está em (1) ou em (2), e as duas são LOCALIZÁVEIS:
//
//   (1) falha  -> erro de LEITURA. Localizado no bloco cuja sintética não bate
//                 com a soma das folhas.
//   (2) falha  -> erro de COBERTURA (folha que não chegou a nenhuma posição) ou
//                 de DUPLICAÇÃO (folha contada duas vezes).
//
// O v1 media só o sintoma (`dif != 0`) e não tinha nenhuma dessas duas
// verificações, então a diferença era indebugável: 229 entradas de dicionário
// descartavam valor silenciosamente e nada no sistema sabia disso.
//
// ---------------------------------------------------------------------------
// IMUNIDADE A ERRO DE JULGAMENTO
// ---------------------------------------------------------------------------
// Como Passivo Circulante, Não Circulante e PL todos desembocam em
// `Passivo + PL` (linhas 72 e 80 do template), QUALQUER realocação dentro desse
// conjunto é neutra para o fechamento. O mesmo vale dentro do Ativo. Só três
// coisas quebram a identidade - e são exatamente as três que o código verifica:
//
//   A. atravessar o lado (Ativo <-> Passivo, ou BP <-> DRE)
//   B. cair num subtotal (kind:"calc", sem bucket -> valor evapora)
//   C. cair num destino inexistente (chave órfã)
//
// Ou seja: o LLM decide QUAL das 79 posições - julgamento revisável, que afeta
// KPI e composição - e o código garante que essa decisão não pode furar o
// balanço. As duas coisas são ortogonais, e é isso que permite usar um modelo
// local pequeno sem abrir mão da correção.

import { num, round2 } from './normalize.js';
import { aggKey } from './keys.js';
import { ladoDoBalanco, resolveDestinoAlocavel } from './planoContas.js';

export const ANOS = ['ano1', 'ano2', 'ano3'];

/**
 * Tolerância do fechamento: relativa ao tamanho do Ativo, com piso absoluto.
 *
 * O v1 usava `< 0.5` absoluto, o que é incoerente: para valores em unidades é
 * frouxo demais, e para um Ativo de R$ 118 milhões um resíduo de arredondamento
 * de R$ 1 já reprovava um balanço legitimamente fechado. O guia operacional
 * especifica ~1% do Ativo; usamos 0,05%, que é bem mais rigoroso e ainda
 * absorve arredondamento de centavos em valores grandes.
 */
export function tolerancia(ativo, { relativa = 0.0005, piso = 0.5 } = {}) {
  return Math.max(piso, Math.abs(num(ativo)) * relativa);
}

// ---------------------------------------------------------------------------
// (1) O documento fecha consigo mesmo?
// ---------------------------------------------------------------------------
/**
 * Confere cada conta sintética contra a soma das suas folhas descendentes.
 *
 * É a verificação de LEITURA. No balancete SPE (exemplo) são 134 sintéticas x 5
 * colunas = 670 assertivas; passam todas quando a natureza D/C é aplicada e
 * falham 72 quando não é - o que localiza o erro imediatamente.
 *
 * @param {Array} rows linhas anotadas por anotarHierarquia (com `_folha`, `codigo`)
 * @param {string[]} colunas nomes das colunas de valor a conferir
 * @param {(row:object, coluna:string)=>number|null} valorDe
 * @returns {{ok:boolean, testes:number, divergencias:Array}}
 */
export function verificarSinteticas(rows, colunas, valorDe) {
  const lista = rows || [];
  const digitos = (r) => String(r.codigo ?? '').replace(/\D/g, '');
  const comCodigo = lista.filter((r) => digitos(r));
  if (comCodigo.length < 2) return { ok: true, testes: 0, divergencias: [] };

  const folhas = comCodigo.filter((r) => r._folha);
  const sinteticas = comCodigo.filter((r) => !r._folha);
  const divergencias = [];
  let testes = 0;

  for (const s of sinteticas) {
    const pref = digitos(s);
    const descendentes = folhas.filter((f) => {
      const c = digitos(f);
      return c.length > pref.length && c.startsWith(pref);
    });
    if (!descendentes.length) continue;
    for (const col of colunas) {
      const declarado = valorDe(s, col);
      if (declarado === null || declarado === undefined) continue;
      testes += 1;
      const somado = descendentes.reduce((acc, f) => acc + num(valorDe(f, col)), 0);
      const tol = Math.max(0.05, Math.abs(declarado) * 0.0005);
      if (Math.abs(somado - declarado) > tol) {
        divergencias.push({
          codigo: pref,
          origem: s.origem,
          coluna: col,
          declarado: round2(declarado),
          somaFolhas: round2(somado),
          diferenca: round2(somado - declarado),
          nFolhas: descendentes.length,
        });
      }
    }
  }
  return { ok: divergencias.length === 0, testes, divergencias };
}

// ---------------------------------------------------------------------------
// (2) A alocação conserva valor?
// ---------------------------------------------------------------------------
/**
 * Trilha de conservação de valor: para onde foi cada centavo das folhas.
 *
 * A identidade que precisa valer, por ano:
 *
 *   Σ(folhas alocadas)  =  Σ(chegou numa posição do template)
 *                        + Σ(chave órfã)
 *                        + Σ(alocada em subtotal)
 *                        + Σ(marcada "Sim" mas sem destino)
 *
 * Nada some sem aparecer numa dessas linhas. Este é o painel que faltava no v1
 * e que torna todo vazamento visível em um olhar.
 *
 * @param {Array} rows linhas finalizadas (com ano1..3, destino, grupo, sub)
 * @param {Map<string, object>} bucketsAgregados aggKey -> {ano1,ano2,ano3}
 * @param {Set<string>} chavesDoTemplate aggKeys que a Shadow sabe agregar
 */
export function trilhaDeValor(rows, bucketsAgregados, chavesDoTemplate,
  chavesMemo = new Set()) {
  const zero = () => ({ ano1: 0, ano2: 0, ano3: 0 });
  const trilha = {
    folhasSim: zero(),
    alocado: zero(),
    orfao: zero(),
    subtotal: zero(),
    semDestino: zero(),
    ladoTrocado: zero(),
    memoDre: zero(),
  };
  const detalhes = {
    orfao: [], subtotal: [], semDestino: [], ladoTrocado: [], memoDre: [],
  };

  const somar = (alvo, r) => {
    for (const a of ANOS) alvo[a] += num(r[a]);
  };

  for (const r of rows || []) {
    if (r.alocacaoHierarquia !== 'Sim') continue;
    somar(trilha.folhasSim, r);

    const nome = String(r.destino ?? '').trim();
    if (!nome) {
      somar(trilha.semDestino, r);
      detalhes.semDestino.push({ id: r.id, origem: r.origem, codigo: r.codigo,
        ano1: r.ano1, ano2: r.ano2, ano3: r.ano3 });
      continue;
    }
    const res = resolveDestinoAlocavel(nome, r.grupo, r.subCategoria);
    if (!res.ok) {
      const balde = /subtotal/i.test(res.erro || '') ? 'subtotal' : 'orfao';
      somar(trilha[balde], r);
      detalhes[balde].push({ id: r.id, origem: r.origem, destino: nome,
        grupo: r.grupo, subCategoria: r.subCategoria, erro: res.erro,
        ano1: r.ano1, ano2: r.ano2, ano3: r.ano3 });
      continue;
    }
    // lado do DESTINO resolvido vs lado DECLARADO no documento (do código
    // contábil, quando houver): divergência aqui é a única classe de erro de
    // julgamento que quebra o fechamento
    const ladoDestino = ladoDoBalanco(res.conta.grupo, res.conta.subCategoria);
    const ladoLinha = r._ladoDeclarado || ladoDoBalanco(r.grupo, r.subCategoria);
    if (ladoLinha && ladoDestino && ladoLinha !== ladoDestino) {
      somar(trilha.ladoTrocado, r);
      detalhes.ladoTrocado.push({ id: r.id, origem: r.origem, destino: res.conta.destino,
        ladoLinha, ladoDestino, ano1: r.ano1, ano2: r.ano2, ano3: r.ano3 });
      continue;
    }
    const k = aggKey(res.conta.destino, res.conta.grupo, res.conta.subCategoria);
    if (!chavesDoTemplate.has(k)) {
      somar(trilha.orfao, r);
      detalhes.orfao.push({ id: r.id, origem: r.origem, destino: res.conta.destino,
        chave: k, erro: 'chave não existe no grafo da Shadow',
        ano1: r.ano1, ano2: r.ano2, ano3: r.ano3 });
      continue;
    }
    somar(trilha.alocado, r);
    // Posição de MEMORANDO da DRE (16/17/19): o valor chega à Shadow e aparece
    // na linha, mas não alcança o `Lucro Liquido`. Registrado à parte para
    // explicar diferença de resultado sem parecer que o valor sumiu.
    if (chavesMemo.has(k)) {
      somar(trilha.memoDre, r);
      detalhes.memoDre.push({ id: r.id, origem: r.origem, destino: res.conta.destino,
        ano1: r.ano1, ano2: r.ano2, ano3: r.ano3 });
    }
  }

  // Confere contra o que a agregação realmente produziu (pega divergência entre
  // esta contagem e o Map da Shadow - não deveria acontecer nunca).
  const agregado = zero();
  for (const [k, v] of bucketsAgregados || new Map()) {
    if (!chavesDoTemplate.has(k)) continue;
    for (const a of ANOS) agregado[a] += num(v[a]);
  }

  const perdas = {};
  const conservado = {};
  for (const a of ANOS) {
    const perdido = trilha.orfao[a] + trilha.subtotal[a]
      + trilha.semDestino[a] + trilha.ladoTrocado[a];
    perdas[a] = round2(perdido);
    const soma = trilha.alocado[a] + perdido;
    conservado[a] = Math.abs(soma - trilha.folhasSim[a]) < 0.05
      && Math.abs(agregado[a] - trilha.alocado[a]) < 0.05;
  }

  const arred = (o) => Object.fromEntries(ANOS.map((a) => [a, round2(o[a])]));
  return {
    folhasSim: arred(trilha.folhasSim),
    alocado: arred(trilha.alocado),
    agregado: arred(agregado),
    orfao: arred(trilha.orfao),
    subtotal: arred(trilha.subtotal),
    semDestino: arred(trilha.semDestino),
    ladoTrocado: arred(trilha.ladoTrocado),
    // memoDre NÃO é perda: o valor está na Shadow. Só não alcança o resultado.
    memoDre: arred(trilha.memoDre),
    perdas,
    conservado,
    ok: ANOS.every((a) => conservado[a] && perdas[a] === 0),
    detalhes,
  };
}

// ---------------------------------------------------------------------------
// A identidade - simples e estendida
// ---------------------------------------------------------------------------
/**
 * Avalia `Ativo = Passivo + PL` e a versão ESTENDIDA que inclui o resultado.
 *
 * Num balancete cujo resultado ainda não foi transportado ao PL, a identidade
 * simples NÃO fecha por definição, e a diferença é exatamente o resultado do
 * período. Verificado no Balancete SPE (exemplo) 05.2026:
 *
 *   Ativo         118.035.576,14
 *   Passivo + PL  118.724.714,55
 *   diferença       -689.138,41
 *   Receitas       28.281.223,87
 *   Despesas       28.970.362,28
 *   resultado       -689.138,41   <- idêntico, resíduo 0,00
 *
 * Quando a estendida fecha e a simples não, a diferença não é erro: é o
 * resultado do exercício, e o valor exato do transporte já é conhecido. O
 * sistema deve EXPLICAR isso, não acusar "não fecha".
 *
 * @param {{ativo:object, passivoPl:object, resultado:object,
 *           receitas?:object, despesas?:object}} totais
 *   cada um `{ano1, ano2, ano3}`. `resultado` vem da linha 35 do template
 *   (`Lucro Liquido`); `receitas`/`despesas` são apenas informativas.
 */
export function avaliarIdentidade(totais) {
  const g = (o, a) => num((o || {})[a]);
  const out = {};
  for (const a of ANOS) {
    const ativo = g(totais.ativo, a);
    const passivoPl = g(totais.passivoPl, a);
    const receitas = g(totais.receitas, a);
    const despesas = g(totais.despesas, a);
    const resultado = g(totais.resultado, a);

    const dif = round2(ativo - passivoPl);
    const difEstendida = round2(ativo - passivoPl - resultado);
    const tol = tolerancia(ativo);
    const semDados = Math.abs(ativo) < 0.5 && Math.abs(passivoPl) < 0.5;

    const fecha = Math.abs(dif) <= tol;
    const fechaEstendida = Math.abs(difEstendida) <= tol;
    // resultado != 0 evita classificar como "não encerrado" um balanço em que
    // a DRE simplesmente não foi capturada
    const naoEncerrado = !fecha && fechaEstendida && Math.abs(resultado) > tol;

    out[a] = {
      ativo: round2(ativo),
      passivoPl: round2(passivoPl),
      receitas: round2(receitas),
      despesas: round2(despesas),
      resultado: round2(resultado),
      dif,
      difEstendida,
      difRelativa: Math.abs(ativo) > 0 ? Math.abs(dif) / Math.abs(ativo) : 0,
      tolerancia: round2(tol),
      semDados,
      fecha,
      fechaEstendida,
      naoEncerrado,
      // `ok` = pronto para entregar: fecha a identidade simples
      ok: semDados || fecha,
      // valor exato a transportar para o PL (negativo = prejuízo reduz o PL)
      transporteSugerido: naoEncerrado ? round2(resultado) : null,
    };
  }
  return out;
}

/**
 * Constrói a linha de transporte do resultado para o PL.
 *
 * Detalhe que no v1 dobrava o erro em vez de corrigir: a linha inserida
 * passava de novo por `applySignToRows`, e com `isBalancete` ligado o
 * `sinalGrupo('Passivo') = -1` NEGAVA o valor. A diferença crescia 2x o
 * resultado. Aqui a linha nasce com `_sinalAplicado: true` e o pipeline a
 * respeita - o valor gravado é o valor final, sem nova conversão.
 *
 * @param {object} identidade saída de avaliarIdentidade() (chaveada por ano1..3)
 * @param {string[]} anos rótulos REAIS dos períodos, na ordem de computeYears()
 * @param {{destino?:string, origem?:string}} [opts]
 * @returns {object|null} linha pronta para o array de rows, ou null
 */
export function linhaDeTransporteDoResultado(identidade, anos, opts = {}) {
  // Mapeia slot -> rótulo real. Sem isto, a linha entraria com a chave "ano3"
  // como se fosse um período novo, `computeYears` passaria a ver dois períodos e
  // TODOS os slots se deslocariam: o balanço da coluna real iria para Ano 2 e o
  // Ano 3 conteria apenas o transporte. Foi exatamente o bug que a suíte pegou.
  const lista = anos || [];
  const offset = 3 - lista.length;
  const rotuloDoSlot = {};
  lista.forEach((y, i) => { rotuloDoSlot[`ano${offset + i + 1}`] = y; });

  const valores = {};
  let algum = false;
  for (const a of ANOS) {
    const t = identidade?.[a]?.transporteSugerido;
    if (t === null || t === undefined || Math.abs(t) < 0.005) continue;
    const rotulo = rotuloDoSlot[a];
    if (!rotulo) continue; // slot sem período real: nada a transportar
    valores[rotulo] = t;
    algum = true;
  }
  if (!algum) return null;
  return {
    origem: opts.origem || 'Resultado do Exercício (transporte automático)',
    hierarquia: '',
    codigo: '',
    paginaReferencia: '',
    grupo: 'Passivo',
    subCategoria: 'PL',
    // Lucros Acumulados tem sinal 'none': preserva o sinal, então prejuízo
    // entra negativo e reduz o PL, como manda a contabilidade.
    destino: opts.destino || 'Lucros Acumulados',
    tipoMapeamento: 'Transporte de resultado',
    alocacaoHierarquia: 'Sim',
    valoresPorSlot: valores,
    _sinalAplicado: true,
    _transporte: true,
  };
}
