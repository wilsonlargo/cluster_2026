// Supabase Edge Function: monitoreo-rss
// Lee fuentes RSS/Atom registradas en public.monitoreo_fuentes,
// aplica reglas de public.monitoreo_reglas y guarda resultados en public.monitoreo_items.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Fuente = {
  id: string;
  nombre: string;
  url: string;
  tipo: string;
  categoria: string | null;
  activa: boolean;
};

type Regla = {
  id: string;
  nombre: string;
  palabras_incluir: string[];
  palabras_excluir: string[];
  prioridad: "alta" | "media" | "baja";
  activa: boolean;
};

type ItemRSS = {
  titulo: string;
  url: string;
  resumen: string | null;
  fecha_publicacion: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const palabrasTerritorio = [
  "Amazonas", "Antioquia", "Arauca", "Atlántico", "Bolívar", "Boyacá", "Caldas", "Caquetá",
  "Casanare", "Cauca", "Cesar", "Chocó", "Córdoba", "Cundinamarca", "Guainía", "Guaviare",
  "Huila", "La Guajira", "Magdalena", "Meta", "Nariño", "Norte de Santander", "Putumayo",
  "Quindío", "Risaralda", "San Andrés", "Santander", "Sucre", "Tolima", "Valle del Cauca", "Vaupés", "Vichada",
];

const pueblosBase = [
  "Nasa", "Wayuu", "Embera", "Emberá", "Awá", "Wiwa", "Kogui", "Arhuaco", "Yukpa", "Sikuani", "Nukak",
  "Tikuna", "Uitoto", "Huitoto", "Bora", "Okaina", "Inga", "Kamëntsá", "Misak", "Pijao", "Zenú", "Mokaná",
  "Wounaan", "Barí", "U'wa", "Kankuamo", "Tule", "Palenquero",
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function decodeEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(input: string): string {
  return decodeEntities(input)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = xml.match(re);
  return match ? stripHtml(match[1]) : null;
}

function getLink(xml: string): string | null {
  const linkText = getTag(xml, "link");
  if (linkText) return linkText.trim();

  const href = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
  if (href?.[1]) return decodeEntities(href[1]).trim();

  return null;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function extractBlocks(xml: string, tag: "item" | "entry"): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) blocks.push(match[0]);
  return blocks;
}

function parseFeed(xml: string, maxItems: number): ItemRSS[] {
  const blocks = [...extractBlocks(xml, "item"), ...extractBlocks(xml, "entry")].slice(0, maxItems);

  return blocks
    .map((block) => {
      const titulo = getTag(block, "title") || "Sin título";
      const url = getLink(block) || getTag(block, "guid") || "";
      const resumen = getTag(block, "description") || getTag(block, "summary") || getTag(block, "content") || null;
      const fecha = getTag(block, "pubDate") || getTag(block, "published") || getTag(block, "updated") || null;
      return {
        titulo,
        url: url.trim(),
        resumen,
        fecha_publicacion: normalizeDate(fecha),
      };
    })
    .filter((item) => item.url && item.titulo);
}

function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function incluye(textoNormalizado: string, palabra: string): boolean {
  const p = normalizarTexto(palabra || "").trim();
  if (!p) return false;
  return textoNormalizado.includes(p);
}

function detectarCoincidencias(texto: string, palabras: string[]): string[] {
  const textoNorm = normalizarTexto(texto);
  return [...new Set((palabras || []).filter((p) => incluye(textoNorm, p)))];
}

function evaluarItem(item: ItemRSS, reglas: Regla[]) {
  const texto = `${item.titulo} ${item.resumen || ""}`;
  const textoNorm = normalizarTexto(texto);

  let puntaje = 0;
  let prioridad: "alta" | "media" | "baja" = "baja";
  const palabrasClave: string[] = [];
  const reglasActivadas: string[] = [];

  for (const regla of reglas) {
    const incluidas = (regla.palabras_incluir || []).filter((p) => incluye(textoNorm, p));
    const excluidas = (regla.palabras_excluir || []).filter((p) => incluye(textoNorm, p));

    if (incluidas.length === 0) continue;

    const base = regla.prioridad === "alta" ? 50 : regla.prioridad === "media" ? 30 : 15;
    puntaje += base + incluidas.length * 8 - excluidas.length * 12;
    palabrasClave.push(...incluidas);
    reglasActivadas.push(regla.nombre);

    if (regla.prioridad === "alta") prioridad = "alta";
    else if (regla.prioridad === "media" && prioridad !== "alta") prioridad = "media";
  }

  const territorioDetectado = palabrasTerritorio.find((d) => incluye(textoNorm, d)) || null;
  const puebloDetectado = pueblosBase.find((p) => incluye(textoNorm, p)) || null;

  if (territorioDetectado) puntaje += 10;
  if (puebloDetectado) puntaje += 15;

  return {
    puntaje: Math.max(0, Math.min(100, puntaje)),
    prioridad,
    palabrasClave: [...new Set(palabrasClave)],
    reglasActivadas,
    departamentoDetectado: territorioDetectado,
    puebloDetectado,
  };
}

async function fetchFeed(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Observatorio-DDHH-RSS/1.0",
      "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al consultar ${url}`);
  }

  return await response.text();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método no permitido" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const authHeader = req.headers.get("Authorization") || "";

    if (!supabaseUrl || !supabaseAnonKey) {
      return jsonResponse({ error: "Faltan variables SUPABASE_URL o SUPABASE_ANON_KEY" }, 500);
    }

    if (!authHeader.startsWith("Bearer ")) {
      return jsonResponse({ error: "Debe iniciar sesión para ejecutar el monitoreo." }, 401);
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
      return jsonResponse({ error: "Sesión inválida o expirada." }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const maxFuentes = Number(body.maxFuentes || 25);
    const maxItemsPorFuente = Number(body.maxItemsPorFuente || 20);

    const { data: fuentes, error: errorFuentes } = await supabase
      .from("monitoreo_fuentes")
      .select("id,nombre,url,tipo,categoria,activa")
      .eq("activa", true)
      .in("tipo", ["rss", "institucional", "organizacion", "medio", "web"])
      .limit(maxFuentes);

    if (errorFuentes) throw errorFuentes;

    const { data: reglas, error: errorReglas } = await supabase
      .from("monitoreo_reglas")
      .select("id,nombre,palabras_incluir,palabras_excluir,prioridad,activa")
      .eq("activa", true);

    if (errorReglas) throw errorReglas;

    let consultadas = 0;
    let leidas = 0;
    let candidatas = 0;
    let guardadas = 0;
    const errores: { fuente: string; url: string; error: string }[] = [];

    for (const fuente of (fuentes || []) as Fuente[]) {
      try {
        consultadas++;
        const xml = await fetchFeed(fuente.url);
        const items = parseFeed(xml, maxItemsPorFuente);
        leidas += items.length;

        for (const item of items) {
          const evaluacion = evaluarItem(item, (reglas || []) as Regla[]);
          if (evaluacion.puntaje <= 0 || evaluacion.palabrasClave.length === 0) continue;

          candidatas++;

          const registro = {
            fuente_id: fuente.id,
            titulo: item.titulo.slice(0, 500),
            url: item.url,
            resumen: item.resumen ? item.resumen.slice(0, 1200) : null,
            fecha_publicacion: item.fecha_publicacion,
            puntaje_relevancia: evaluacion.puntaje,
            prioridad: evaluacion.prioridad,
            estado_revision: "pendiente",
            departamento_detectado: evaluacion.departamentoDetectado,
            municipio_detectado: null,
            pueblo_detectado: evaluacion.puebloDetectado,
            palabras_clave: evaluacion.palabrasClave,
          };

          const { error: upsertError } = await supabase
            .from("monitoreo_items")
            .upsert(registro, { onConflict: "url", ignoreDuplicates: true });

          if (!upsertError) guardadas++;
        }
      } catch (error) {
        errores.push({
          fuente: fuente.nombre,
          url: fuente.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return jsonResponse({
      ok: true,
      consultadas,
      leidas,
      candidatas,
      guardadas,
      errores,
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, 500);
  }
});
