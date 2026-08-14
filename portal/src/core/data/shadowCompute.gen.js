// GERADO por scripts/gen_knowledge.py a partir de knowledge/. NÃO EDITE.
export const SHADOW_COMPUTE = {
 "AP": [
  {
   "row": 5,
   "destino": "Caixa",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 6,
   "destino": "Aplicações Financeiras",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 7,
   "destino": "Disponibilidades",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      6
     ]
    },
    {
     "sign": 1,
     "rows": [
      5
     ]
    }
   ]
  },
  {
   "row": 8,
   "destino": "Clientes",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 9,
   "destino": "Clientes - Grupo",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 10,
   "destino": "-PDD",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "neg"
  },
  {
   "row": 11,
   "destino": "Clientes Líquido",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      8
     ]
    },
    {
     "sign": 1,
     "rows": [
      9
     ]
    },
    {
     "sign": -1,
     "rows": [
      10
     ]
    }
   ]
  },
  {
   "row": 12,
   "destino": "Matéria-Prima",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 13,
   "destino": "Produtos em Elaboração",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 14,
   "destino": "Produtos Acabados",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 15,
   "destino": "Estoques",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      12
     ]
    },
    {
     "sign": 1,
     "rows": [
      13
     ]
    },
    {
     "sign": 1,
     "rows": [
      14
     ]
    }
   ]
  },
  {
   "row": 16,
   "destino": "Ajustes derivativos / cambio (AC)",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 17,
   "destino": "Adiantamento a Fornecedores",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 18,
   "destino": "Mútuo Financeiro",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 19,
   "destino": "Impostos a Recuperar",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 20,
   "destino": "Outros Operacionais (AC)",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 21,
   "destino": "Outros Não Operacionais (AC)",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 22,
   "destino": "TOTAL ATIVO CIRCULANTE",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      7,
      11,
      15,
      16,
      17,
      18,
      19,
      20,
      21
     ]
    }
   ]
  },
  {
   "row": 23,
   "destino": "Ajustes derivativos / cambio (ANC)",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 24,
   "destino": "Impostos Diferidos",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 25,
   "destino": "Impostos a recuperar/Crédito tributário",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 26,
   "destino": "Mútuo Financeiro LP",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 27,
   "destino": "Aplicações Financeiras de LP",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 28,
   "destino": "Outros Operacionais (ANC)",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 29,
   "destino": "Outros Não Operacionais LP (ANC)",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 30,
   "destino": "TOTAL ATIVO REALIZÁVEL LP",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      23,
      24,
      25,
      26,
      27,
      28,
      29
     ]
    }
   ]
  },
  {
   "row": 31,
   "destino": "Direito de Uso",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 32,
   "destino": "- Depreciação acumulada (Direito de uso)",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "neg"
  },
  {
   "row": 33,
   "destino": "Direito de Uso Líquido",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      31
     ]
    },
    {
     "sign": -1,
     "rows": [
      32
     ]
    }
   ]
  },
  {
   "row": 34,
   "destino": "Terreno",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 35,
   "destino": "Edificios, maquinas e outros",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 36,
   "destino": "-Depreciação Acumulada",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "neg"
  },
  {
   "row": 37,
   "destino": "Imobilizado líquido",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      34
     ]
    },
    {
     "sign": 1,
     "rows": [
      35
     ]
    },
    {
     "sign": -1,
     "rows": [
      36
     ]
    }
   ]
  },
  {
   "row": 38,
   "destino": "Investimentos",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 39,
   "destino": "Outros Ativos Intangiveis / Goodwill",
   "kind": "agg",
   "grupo": "Ativo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 40,
   "destino": "TOTAL ATIVO FIXO",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      37,
      38,
      39,
      33
     ]
    }
   ]
  },
  {
   "row": 41,
   "destino": "TOTAL ATIVO",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      40
     ]
    },
    {
     "sign": 1,
     "rows": [
      30
     ]
    },
    {
     "sign": 1,
     "rows": [
      22
     ]
    }
   ]
  },
  {
   "row": 44,
   "destino": "PASSIVO",
   "kind": "calc",
   "terms": []
  },
  {
   "row": 45,
   "destino": "Bancos",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 46,
   "destino": "Outras Dividas Financeiras",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 47,
   "destino": "Confirming",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 48,
   "destino": "Dividas Fiscais de Curto Prazo",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 49,
   "destino": "Ajustes derivativos / cambio (+)",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 50,
   "destino": "Fornecedores",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 51,
   "destino": "Fornecedores - Partes Relacionadas",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 52,
   "destino": "Fornecedores Totais",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      50
     ]
    },
    {
     "sign": 1,
     "rows": [
      51
     ]
    }
   ]
  },
  {
   "row": 53,
   "destino": "Passivo de Arrendamento Circulante",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 54,
   "destino": "Mútuo Financeiro",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 55,
   "destino": "Salários",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 56,
   "destino": "Impostos",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 57,
   "destino": "Adiantamento de Clientes",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 58,
   "destino": "Dividendos a Pagar",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 59,
   "destino": "Outros Operacionais (PC)",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 60,
   "destino": "Outros Não Operacionais (PC)",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Circulante",
   "sign": "none"
  },
  {
   "row": 61,
   "destino": "TOTAL PASSIVO CIRCULANTE",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      52,
      53,
      54,
      55,
      56,
      57,
      58,
      59,
      60
     ]
    },
    {
     "sign": 1,
     "rows": [
      45,
      46,
      47,
      48,
      49
     ]
    }
   ]
  },
  {
   "row": 62,
   "destino": "Bancos LP",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 63,
   "destino": "Outras Dividas Financeiras LP",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 64,
   "destino": "Dividas Fiscais LP",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 65,
   "destino": "Ajustes derivativos / cambio (PNC)",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 66,
   "destino": "Passivo de Arrendamento LP",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 67,
   "destino": "Mútuo Financeiro LP",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 68,
   "destino": "Provisões",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 69,
   "destino": "Outros Operacionais (PNC)",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 70,
   "destino": "Outros Não Operacionais (PNC)",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "Não Circulante",
   "sign": "none"
  },
  {
   "row": 71,
   "destino": "TOTAL PASSIVO NÃO CIRCULANTE",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      62,
      63,
      64,
      65,
      66,
      67,
      68,
      69,
      70
     ]
    }
   ]
  },
  {
   "row": 72,
   "destino": "TOTAL PASSIVO",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      71
     ]
    },
    {
     "sign": 1,
     "rows": [
      61
     ]
    }
   ]
  },
  {
   "row": 75,
   "destino": "PARTICIPAÇÕES MINORITÁRIAS",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "PL",
   "sign": "none"
  },
  {
   "row": 76,
   "destino": "Capital Social",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "PL",
   "sign": "none"
  },
  {
   "row": 77,
   "destino": "Lucros Acumulados",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "PL",
   "sign": "none"
  },
  {
   "row": 78,
   "destino": "Outras Reservas",
   "kind": "agg",
   "grupo": "Passivo",
   "subCategoria": "PL",
   "sign": "none"
  },
  {
   "row": 79,
   "destino": "PATRIMÔNIO LÍQUIDO",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      76,
      77,
      78
     ]
    }
   ]
  },
  {
   "row": 80,
   "destino": "RECURSOS PROPRIOS - Reportado com IFRS16",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      75,
      79
     ]
    }
   ]
  }
 ],
 "DRE": [
  {
   "row": 5,
   "destino": "Vendas Totais",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "none"
  },
  {
   "row": 6,
   "destino": "-Impostos",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 7,
   "destino": "Vendas Líquidas",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      5
     ]
    },
    {
     "sign": -1,
     "rows": [
      6
     ]
    }
   ]
  },
  {
   "row": 8,
   "destino": "-Custo de Produtos Vendidos",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 9,
   "destino": "Resultado Bruto",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      7
     ]
    },
    {
     "sign": -1,
     "rows": [
      8
     ]
    }
   ]
  },
  {
   "row": 10,
   "destino": "- Despesas com Vendas",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 11,
   "destino": "- Despesas Administrativas",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 12,
   "destino": "Resultado da Exploração ",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      9
     ]
    },
    {
     "sign": -1,
     "rows": [
      10
     ]
    },
    {
     "sign": -1,
     "rows": [
      11
     ]
    }
   ]
  },
  {
   "row": 13,
   "destino": "+/-Outras Receitas/Despesas Operacionais",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pm"
  },
  {
   "row": 14,
   "destino": "+/-Provisões Operacionais",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pm"
  },
  {
   "row": 15,
   "destino": "Resultado Operacional (EBIT)",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      12,
      13,
      14
     ]
    }
   ]
  },
  {
   "row": 16,
   "destino": "- Depreciação e amortização (imob e intang)",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 17,
   "destino": "- Depreciação/Amortização dos Arrendamentos Op.",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 18,
   "destino": "EBITDA",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      15
     ]
    },
    {
     "sign": 1,
     "rows": [
      16
     ]
    },
    {
     "sign": 1,
     "rows": [
      17
     ]
    },
    {
     "sign": -1,
     "rows": [
      14
     ]
    }
   ]
  },
  {
   "row": 19,
   "destino": "- Despesas/Custo de Aluguel",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 20,
   "destino": "EBITDA ex-IFRS16",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      18
     ]
    },
    {
     "sign": 1,
     "rows": [
      19
     ]
    }
   ]
  },
  {
   "row": 21,
   "destino": "-  Despesas Financeiras",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 22,
   "destino": "+ Receitas Financeiras",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pos"
  },
  {
   "row": 23,
   "destino": "+/- Resultado Financeiro",
   "kind": "calc",
   "terms": [
    {
     "sign": -1,
     "rows": [
      21
     ]
    },
    {
     "sign": 1,
     "rows": [
      22
     ]
    }
   ]
  },
  {
   "row": 24,
   "destino": "+/- Variações Cambiais",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pm"
  },
  {
   "row": 25,
   "destino": "+/- Equivalência Patrimonial",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pm"
  },
  {
   "row": 26,
   "destino": "Lucro antes de Impostos e Extraordinários",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      15
     ]
    },
    {
     "sign": 1,
     "rows": [
      23
     ]
    },
    {
     "sign": 1,
     "rows": [
      24
     ]
    },
    {
     "sign": 1,
     "rows": [
      25
     ]
    }
   ]
  },
  {
   "row": 27,
   "destino": "Outros não recorrentes e/ou não operacionais",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "none"
  },
  {
   "row": 28,
   "destino": "+/- Créditos Tributários",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pm"
  },
  {
   "row": 29,
   "destino": "+/- Resultado de alienação do Imobilizado",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pm"
  },
  {
   "row": 30,
   "destino": "- Juros de Arrendamento Operacional",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 31,
   "destino": "+/- Resultado Extraordinário",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      27
     ]
    },
    {
     "sign": 1,
     "rows": [
      28
     ]
    },
    {
     "sign": 1,
     "rows": [
      29
     ]
    },
    {
     "sign": -1,
     "rows": [
      30
     ]
    }
   ]
  },
  {
   "row": 32,
   "destino": "Lucro antes de Impostos ",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      26
     ]
    },
    {
     "sign": 1,
     "rows": [
      31
     ]
    }
   ]
  },
  {
   "row": 33,
   "destino": "- Impostos Pagos",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 34,
   "destino": "+/- Impostos Diferidos",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pm"
  },
  {
   "row": 35,
   "destino": "Lucro Liquido",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      32
     ]
    },
    {
     "sign": -1,
     "rows": [
      33
     ]
    },
    {
     "sign": 1,
     "rows": [
      34
     ]
    }
   ]
  },
  {
   "row": 36,
   "destino": "+/- Resultados Abrangentes",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pm"
  },
  {
   "row": 37,
   "destino": "Lucro Líquido+Resultado Abrangente a Distribuir",
   "kind": "calc",
   "terms": [
    {
     "sign": 1,
     "rows": [
      35
     ]
    },
    {
     "sign": 1,
     "rows": [
      36
     ]
    }
   ]
  },
  {
   "row": 39,
   "destino": "- Dividendos",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "neg"
  },
  {
   "row": 40,
   "destino": "+/- Participações Minoritárias",
   "kind": "agg",
   "grupo": "DRE",
   "subCategoria": "DRE",
   "sign": "pm"
  }
 ]
};
