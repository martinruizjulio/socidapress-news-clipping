import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Newspaper,
  FileUp,
  Download,
  RotateCcw,
  Loader2,
  Library,
  Trash2,
  Save,
  ArrowLeft,
  Pencil,
} from "lucide-react";

// Tipos internos
interface ExtractedImage {
  id: string;
  page: number;
  dataUrl: string;
  width: number;
  height: number;
}

interface ExtractedTextBlock {
  id: string;
  page: number;
  // Índice de la zona marcada por el usuario dentro de la página (1..n).
  zona?: number;
  titulo?: string;
  fecha?: string;
  hora?: string;
  text: string;
  // Recorte mejorado (redimensionado + ajuste de luz/color) de la zona.
  cropDataUrl?: string;
}

interface Metadata {
  periodico: string;
  titulo: string;
  fecha: string;
  hora: string;
}

type Stage = "form" | "region" | "processing" | "select" | "done" | "library";

// Noticia guardada persistente (localStorage). Contiene todo lo necesario
// para mostrarla y editarla más tarde sin volver a procesar el PDF.
interface SavedBlock {
  id: string;
  page: number;
  titulo: string;
  fecha: string;
  hora: string;
  texto: string;
  imagenPagina?: string | null;
  imagenSeleccion?: string | null;
}
interface SavedNoticia {
  id: string;
  createdAt: number;
  updatedAt: number;
  periodico: string;
  titulo: string;
  fecha: string;
  hora: string;
  bloques: SavedBlock[];
  imagenes: { id: string; dataUrl: string; ancho: number; alto: number }[];
}

const STORAGE_KEY = "socidapress:noticias";

function cargarNoticias(): SavedNoticia[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function guardarNoticias(list: SavedNoticia[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.error(e);
    toast.error("No se pudo guardar en la biblioteca (¿espacio agotado?).");
  }
}

// Imagen completa de una página + (opcional) recorte de la zona marcada.
// Sirve como "prueba visual" que acompaña a los bloques extraídos.
interface PageImage {
  page: number;
  fullDataUrl: string;
  cropDataUrl?: string;
}

// Rectángulo de recorte en coordenadas de usuario del PDF (mismo espacio que
// los items de texto nativos y el viewBox de pdfjs).
type PdfRect = { xMin: number; xMax: number; yMin: number; yMax: number };

// Miniatura de página + info de viewport necesaria para mapear coordenadas
// pantalla <-> PDF y aplicar el recorte durante el procesado.
interface PageThumb {
  page: number;
  dataUrl: string;
  canvasWidth: number;
  canvasHeight: number;
  viewBox: [number, number, number, number];
  // Rotación intrínseca leída del PDF (0/90/180/270). La rotación final
  // aplicada por el usuario se guarda aparte en `rotations`.
  pdfRotation: number;
}

// Convierte un ImageData / canvas a dataURL webp
function canvasToWebp(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/webp", 0.92);
}

// Renderiza una imagen de pdfjs a dataURL
function pdfImageToDataUrl(img: {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  kind?: number;
}): string | null {
  try {
    const { width, height, data, kind } = img;
    if (!width || !height || !data) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const imageData = ctx.createImageData(width, height);
    const dst = imageData.data;
    if (kind === 1) {
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        dst[j] = data[i];
        dst[j + 1] = data[i];
        dst[j + 2] = data[i];
        dst[j + 3] = 255;
      }
    } else if (kind === 2 || data.length === width * height * 3) {
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        dst[j] = data[i];
        dst[j + 1] = data[i + 1];
        dst[j + 2] = data[i + 2];
        dst[j + 3] = 255;
      }
    } else {
      dst.set(data);
    }
    ctx.putImageData(imageData, 0, 0);
    return canvasToWebp(canvas);
  } catch {
    return null;
  }
}

// Meses en español para reconocer fechas escritas con letras
const MESES: Record<string, string> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  setiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

// Periódicos permitidos (orden por prioridad de detección: primero los que no
// generan falsos positivos; "AS" al final por ser una palabra muy corta).
const PERIODICOS_CONOCIDOS = ["Superdeporte", "Mundo Deportivo", "Marca", "Sport", "AS"] as const;

// Detecta el periódico buscando su nombre en el texto completo de la página.
// Prioriza coincidencias con "DIARIO <X>" y exige límites de palabra.
function detectarPeriodico(fullText: string): string {
  const t = fullText;
  for (const nombre of PERIODICOS_CONOCIDOS) {
    const reDiario = new RegExp(`DIARIO\\s+${nombre}`, "i");
    if (reDiario.test(t)) return nombre;
  }
  for (const nombre of PERIODICOS_CONOCIDOS) {
    // Límite razonable: no debe formar parte de otra palabra
    const re = new RegExp(`(^|[^A-Za-zÁÉÍÓÚÑ])${nombre}([^A-Za-zÁÉÍÓÚÑ]|$)`, "i");
    if (re.test(t)) return nombre;
  }
  return "";
}

// Intenta extraer periódico, título, fecha y hora del texto de la página.
// `titleFromFont` es el título detectado por tamaño de fuente (más fiable).
function extraerMetadatos(fullText: string, titleFromFont: string): Metadata {
  const md: Metadata = { periodico: "", titulo: "", fecha: "", hora: "" };

  md.periodico = detectarPeriodico(fullText);
  md.titulo = titleFromFont.trim();

  // Fecha: dd/mm/yyyy o dd-mm-yyyy
  const mNum = fullText.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (mNum) {
    const d = mNum[1].padStart(2, "0");
    const m = mNum[2].padStart(2, "0");
    let y = mNum[3];
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? "19" : "20") + y;
    md.fecha = `${y}-${m}-${d}`;
  }
  if (!md.fecha) {
    // "12 de marzo de 2024"
    const re = new RegExp(
      `\\b(\\d{1,2})\\s+de\\s+(${Object.keys(MESES).join("|")})\\s+de\\s+(\\d{4})\\b`,
      "i",
    );
    const mTxt = fullText.match(re);
    if (mTxt) {
      const d = mTxt[1].padStart(2, "0");
      const m = MESES[mTxt[2].toLowerCase()];
      const y = mTxt[3];
      md.fecha = `${y}-${m}-${d}`;
    }
  }

  // Hora: HH:MM (24h o con h)
  const mHora = fullText.match(/\b([01]?\d|2[0-3])[:.h]([0-5]\d)\b/);
  if (mHora) {
    md.hora = `${mHora[1].padStart(2, "0")}:${mHora[2]}`;
  }

  return md;
}

// Heurística para descartar bloques que son maquetación en lugar de cuerpo:
// firmas ("AS / MADRID", "PEPE ANDRES / DIARIO AS"), cabeceras de sección
// ("Baloncesto", "hípica"), páginas ("DM6"), etiquetas en mayúsculas,
// pies de foto muy cortos, etc.
function esRuidoMaquetacion(texto: string): boolean {
  const s = texto.trim();
  if (!s) return true;
  if (s.length < 60) return true; // fragmentos cortos: cabeceras, pies, folios
  const primeraLinea = s.split(/\r?\n/)[0].trim();
  // Firmas tipo "NOMBRE APELLIDO / CIUDAD" o "AS / MADRID"
  if (/^[A-ZÁÉÍÓÚÑ0-9 .·-]{2,}\s*\/\s*[A-ZÁÉÍÓÚÑ0-9 .·-]{2,}\s*$/.test(primeraLinea)) {
    return true;
  }
  // Todo el bloque en mayúsculas -> titular o antetítulo de maquetación
  const letras = s.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "");
  if (letras.length > 0) {
    const mays = letras.replace(/[^A-ZÁÉÍÓÚÑ]/g, "").length;
    if (mays / letras.length > 0.85) return true;
  }
  // Menciones a los periódicos como créditos ("DIARIO AS", "MARCA / MADRID")
  if (/DIARIO\s+(AS|MARCA|SPORT|SUPERDEPORTE)/i.test(s) && s.length < 120) {
    return true;
  }
  return false;
}

// Filtros a nivel de línea: firmas, folios, cabeceras de sección,
// créditos fotográficos y letras capitulares que la maquetación coloca
// como items independientes en el PDF y contaminarían el cuerpo.
function esLineaRuido(texto: string): boolean {
  const s = texto.trim();
  if (!s) return true;
  // Folio de página tipo "DM6", "AS12", "M3"
  if (/^[A-Z]{1,3}\s?\d{1,4}$/.test(s)) return true;
  // Firma de autor: "NOMBRE APELLIDO / CIUDAD" o "AS / MADRID"
  if (/^[A-ZÁÉÍÓÚÑ0-9.·\- ]{2,}\s*\/\s*[A-ZÁÉÍÓÚÑ0-9.·\- ]{2,}$/.test(s)) return true;
  // Créditos fotográficos: "PEPE ANDRES / DIARIO AS", "COMUNIDAD DE MADRID"
  if (/DIARIO\s+(AS|MARCA|SPORT|SUPERDEPORTE)/i.test(s) && s.length < 60) return true;
  // Todo en mayúsculas y corto -> antetítulo/kicker/sección
  const letras = s.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, "");
  if (letras.length >= 2) {
    const mays = letras.replace(/[^A-ZÁÉÍÓÚÑ]/g, "").length;
    if (mays / letras.length > 0.85 && s.length < 80) return true;
  }
  return false;
}

// Nombre de sección corto ("Baloncesto", "hípica", "Madrid") sin puntuación.
function esEtiquetaSeccion(texto: string): boolean {
  const s = texto.trim();
  if (s.length > 30) return false;
  if (!/^[A-Za-zÁÉÍÓÚÑñáéíóú ]+$/.test(s)) return false;
  return s.split(/\s+/).length <= 3;
}

// Limpia texto (OCR o nativo) eliminando caracteres extraños,
// símbolos sueltos, guiones de fin de línea y espacios repetidos.
function limpiarTexto(texto: string): string {
  let s = texto;
  // Elimina caracteres de control invisibles
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
  // Elimina reemplazos, guiones opcionales y marcas de dirección
  s = s.replace(/[\uFFFD\u00AD\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "");
  // Une marcas combinantes con la letra anterior aunque pdf.js las emita
  // separadas por un espacio (ej. "n \u0303" -> "ñ" tras NFC).
  s = s.replace(/(\p{L})\s+(\p{M})/gu, "$1$2");
  // Ahora sí normaliza a NFC para componer letra + diacrítico -> ñ, á, é...
  s = s.normalize("NFC");
  // Comillas tipográficas y guiones largos -> ASCII
  s = s
    .replace(/[“”«»„]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[–—―]/g, "-");
  // Puntos suspensivos tipográficos
  s = s.replace(/…/g, "...");
  // Guiones de palabras partidas por columnas / fin de línea
  s = s.replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, "$1$2");
  // Une saltos de línea internos de un mismo párrafo (no dobles)
  s = s.replace(/([^\n])\n(?!\n)/g, "$1 ");
  // Whitelist ampliada: incluye marcas combinantes por si quedara alguna.
  s = s.replace(/[^\p{L}\p{M}\p{N}\s.,;:!¡¿?()"'%€$£ºª&/\-\n]/gu, " ");

  // Colapsa espacios
  s = s.replace(/[ \t]{2,}/g, " ");
  s = s.replace(/\s+([.,;:!?])/g, "$1");
  s = s.replace(/\n{3,}/g, "\n\n");
  // Elimina líneas con muy pocas letras o dominadas por ruido no alfabético
  s = s
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      if (!t) return true;
      const letras = t.replace(/[^\p{L}]/gu, "").length;
      if (letras < 4) return false;
      // ratio letras/total razonable
      if (letras / t.length < 0.55) return false;
      return true;
    })
    .join("\n");
  // Palabras de una sola letra sueltas (excepto a, o, y, e, u)
  // Palabras de una sola letra sueltas (excepto a, o, y, e, u). Usamos
  // lookarounds Unicode porque \b en JS ignora los acentos y borraría
  // ñ/á/é interiores de palabras como "años" o "después".
  s = s
    .replace(/(?<![\p{L}\p{N}_])(?![aAoOyYeEuUiI](?![\p{L}\p{N}_]))[\p{L}](?![\p{L}\p{N}_])/gu, "")
    .replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

// ---------------------------------------------------------------------------
// Corrección léxica del texto reconocido por OCR.
// El motor confunde siempre los mismos grupos de letras en prensa impresa
// ("rn" por "m", "x" por "r", "w" por "in"...). Generamos candidatos
// aplicando esas confusiones y solo aceptamos el cambio si la palabra
// original NO está en el léxico y el candidato SÍ lo está: así nunca
// "inventamos" palabras que el OCR había leído bien.
// ---------------------------------------------------------------------------
const LEXICO = new Set<string>(
  (
    "a al algo alguna algunas alguno algunos ante antes año años aunque bien cada casi como con contra cuando cual cuanto de del desde donde dos durante el ella ellas ellos en entre era eran eres es esa esas ese eso esos esta estaba estaban estan estar estas este esto estos fue fueron ha habia han hasta hay he la las le les lo los luego mas me menos mi mientras muy nada ni no nos nunca o otra otras otro otros para pero poco por porque primer primera pues que quien se segun ser si sin sobre solo son su sus tambien tanto te tiene tienen todo toda todas todos tras tu un una uno unos y ya " +
    "partido partidos jugador jugadores equipo equipos entrenador afición campo estadio minuto minutos gol goles temporada liga copa final semifinal cuartos árbitro arbitro victoria derrota empate fichaje club clubes cantera plantilla lesión lesion titular suplente banquillo rival marcador segundos primera segunda tercera ronda combate boxeo boxeadora boxeadoras boxeador púgil pugil cuadrilátero cuadrilatero ovación ovacion asalto asaltos ring pelea peleas campeona campeón campeon medalla oro plata bronce olímpico olimpico olímpica olimpica torneo taiwanesa taiwanés taiwanes argelina argelino género genero intersexual periodista periodistas prueba pruebas polémica polemica público publico " +
    "dijo dice decía hizo hace hacer llegó llego lleva salió salio saltó salto marcha marchó marcho atender identificado identificada superior demostró demostro mucho mucha más agil ágil precisa preciso rápida rapida rápido rapido nueva nuevo nueva controversia antecedente sucedido donde aguantó aguanto unos miradas apuntaban debut oriental envuelta envueltas enfrentaba primer segundo tercero reproches media hora tarde noche mañana manana ayer hoy sábado sabado domingo lunes martes miércoles miercoles jueves viernes enero febrero marzo abril mayo junio julio agosto septiembre octubre noviembre diciembre"
  ).split(/\s+/),
);

const CONFUSIONES: [string, string][] = [
  ["rn", "m"],
  ["m", "rn"],
  ["w", "in"],
  ["in", "w"],
  ["x", "r"],
  ["r", "x"],
  ["cl", "d"],
  ["d", "cl"],
  ["ii", "n"],
  ["n", "ii"],
  ["li", "h"],
  ["h", "li"],
  ["l", "i"],
  ["i", "l"],
  ["1", "l"],
  ["0", "o"],
  ["5", "s"],
  ["8", "b"],
  ["c", "e"],
  ["e", "c"],
  ["vv", "w"],
  ["ll", "ll"],
];

function normalizaClave(palabra: string): string {
  return palabra
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC");
}

function conservaCaja(original: string, corregida: string): string {
  if (original === original.toUpperCase()) return corregida.toUpperCase();
  if (original[0] === original[0]?.toUpperCase())
    return corregida[0]!.toUpperCase() + corregida.slice(1);
  return corregida;
}

function corregirPalabra(palabra: string): string {
  if (palabra.length < 4) return palabra;
  const clave = normalizaClave(palabra);
  if (!/^[a-zñ]+$/.test(clave)) return palabra;
  if (LEXICO.has(clave)) return palabra;
  const aciertos = new Set<string>();
  for (const [de, a] of CONFUSIONES) {
    let desde = 0;
    for (;;) {
      const idx = clave.indexOf(de, desde);
      if (idx === -1) break;
      const cand = clave.slice(0, idx) + a + clave.slice(idx + de.length);
      if (LEXICO.has(cand)) aciertos.add(cand);
      desde = idx + 1;
    }
  }
  // Solo aceptamos la corrección si es inequívoca (un único candidato válido).
  if (aciertos.size !== 1) return palabra;
  return conservaCaja(palabra, [...aciertos][0]!);
}

// Corrige el texto de OCR palabra a palabra respetando puntuación y saltos.
function corregirOcr(texto: string): string {
  return texto.replace(/\p{L}+/gu, (w) => corregirPalabra(w));
}

// Item del PDF con posición y tamaño ya normalizados.
type NativeItem = {
  str: string;
  x: number;
  y: number;
  size: number;
  width: number;
  hasEOL: boolean;
};

// Agrupa items del PDF en bloques de noticia. Cada noticia (delimitada por
// un titular grande) forma UN bloque aunque su cuerpo esté maquetado en
// varias columnas dentro del mismo recuadro. Devuelve además fecha y hora
// detectadas dentro de cada bloque cuando aparecen.
function extraerBloquesNativos(
  items: NativeItem[],
): { titulo?: string; text: string; fecha?: string; hora?: string }[] {
  if (!items.length) return [];

  const sizes = items
    .map((i) => i.size)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] || 10;

  // 1) Construcción de líneas: recorremos los items en orden natural
  //    (por y descendente, x ascendente) y unimos los que van seguidos en
  //    la misma línea horizontal con el mismo tamaño de fuente.
  type Linea = { x: number; xEnd: number; y: number; size: number; text: string };
  const yTol = median * 0.5;
  const ordenados = [...items]
    .filter((i) => i.str.trim() || i.hasEOL)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lineas: Linea[] = [];
  for (const it of ordenados) {
    const str = it.str;
    if (!str) continue;
    const last = lineas[lineas.length - 1];
    // Ancho real del fragmento (pdf.js ya lo calcula con precisión). El
    // margen para considerar que el siguiente fragmento sigue en la misma
    // línea (en vez de ser ya la columna de al lado) tiene que ser
    // pequeño: un espacio real mide como mucho ~1 tamaño de letra, muy
    // lejos de los huecos de varias decenas de puntos que separan dos
    // columnas de un periódico. Antes se usaba un margen fijo de 50pt que
    // terminaba fusionando columnas distintas en una sola "línea".
    const anchoAprox = it.width || it.size * str.length * 0.5;
    const margenMismaLinea = Math.max(it.size * 0.6, 3);
    if (
      last &&
      Math.abs(last.y - it.y) <= yTol &&
      Math.abs(last.size - it.size) < 1 &&
      it.x >= last.xEnd - 5 &&
      it.x <= last.xEnd + margenMismaLinea
    ) {
      last.text += (last.text.endsWith(" ") || str.startsWith(" ") ? "" : " ") + str;
      last.xEnd = it.x + anchoAprox;
    } else {
      lineas.push({ x: it.x, xEnd: it.x + anchoAprox, y: it.y, size: it.size, text: str });
    }
  }

  // Detecta letras capitulares (drop caps): un solo carácter con tamaño
  // notablemente mayor al cuerpo. Antes de descartarlas, las fusionamos
  // con la línea contigua a su derecha para no perder la primera letra
  // del cuerpo ("D" + "el 19…"). Aceptamos hasta 3 caracteres por si el
  // OCR/parser mezcla la capitular con la siguiente ("De" o "Del").
  const capitulares = lineas.filter((l) => l.text.trim().length <= 3 && l.size >= median * 1.9);
  const capSet = new Set(capitulares);
  for (const dc of capitulares) {
    const letra = dc.text.trim();
    // Candidatas: líneas de cuerpo a la derecha de la capitular y dentro
    // de su altura vertical (la capitular ocupa varias líneas de cuerpo).
    const candidatas = lineas
      .filter(
        (l) =>
          !capSet.has(l) &&
          l.x >= dc.xEnd - dc.size * 0.4 &&
          l.x <= dc.xEnd + dc.size * 2.5 &&
          l.y <= dc.y + dc.size * 0.6 &&
          l.y >= dc.y - dc.size * 2.5,
      )
      // La primera línea del párrafo es la más alta (mayor y en pdfjs).
      .sort((a, b) => b.y - a.y);
    const destino = candidatas[0];
    if (destino) destino.text = letra + destino.text;
  }

  const limpias = lineas
    .filter((l) => !capSet.has(l))
    .map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() }))
    .filter((l) => l.text.length > 0);

  // 2) Identificar titulares principales (fuente muy grande) y "decks"
  //    o subtítulos (fuente intermedia). Después agrupamos cada titular
  //    con las líneas grandes/intermedias contiguas por debajo, para que
  //    títulos multilínea y subtítulos formen un único bloque.
  const esHeadline = (l: Linea) =>
    l.size >= median * 1.8 &&
    l.text.length >= 8 &&
    l.text.length < 200 &&
    l.text.split(/\s+/).length >= 2 &&
    l.text.split(/\s+/).length <= 25 &&
    !esLineaRuido(l.text) &&
    !esEtiquetaSeccion(l.text);

  const esSubtitular = (l: Linea) =>
    l.size >= median * 1.3 && l.size < median * 1.8 && l.text.length >= 15 && !esLineaRuido(l.text);

  const porYDesc = (a: Linea, b: Linea) => b.y - a.y;

  // Semillas: titulares principales ordenados de arriba abajo.
  const semillas = limpias.filter(esHeadline).sort(porYDesc);

  type Articulo = {
    headlineTop: number;
    headlineBottom: number;
    xLeft: number;
    xRight: number;
    titulo: string;
  };
  const articulos: Articulo[] = [];

  // Ampliamos cada semilla con las líneas cercanas por debajo cuyo tamaño
  // sea igual (títulos multilínea) o intermedio (deck/subtítulo). Nos
  // detenemos al llegar a texto de cuerpo o a otro titular principal.
  const consumidas = new Set<Linea>();
  for (const seed of semillas) {
    if (consumidas.has(seed)) continue;
    const cluster: Linea[] = [seed];
    consumidas.add(seed);
    const debajo = limpias.filter((l) => !consumidas.has(l) && l.y < seed.y).sort(porYDesc);
    let yRef = seed.y;
    for (const l of debajo) {
      const gap = yRef - l.y;
      if (gap > Math.max(seed.size, l.size) * 2.5) break;
      if (esHeadline(l) && Math.abs(l.size - seed.size) > seed.size * 0.15) break;
      const mismaFuente = Math.abs(l.size - seed.size) <= seed.size * 0.15;
      if (mismaFuente || esSubtitular(l)) {
        cluster.push(l);
        consumidas.add(l);
        yRef = l.y;
        continue;
      }
      break;
    }
    const top = Math.max(...cluster.map((l) => l.y));
    const bottom = Math.min(...cluster.map((l) => l.y));
    const xLeft = Math.min(...cluster.map((l) => l.x));
    const xRight = Math.max(...cluster.map((l) => l.xEnd));
    const titulo = cluster
      .sort(porYDesc)
      .map((l) => l.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    articulos.push({
      headlineTop: top,
      headlineBottom: bottom,
      xLeft,
      xRight,
      titulo,
    });
  }

  articulos.sort((a, b) => b.headlineTop - a.headlineTop);

  // Si no hay titulares detectados, tratamos toda la página como un bloque.
  if (articulos.length === 0) {
    const raw = limpias
      .sort((a, b) => b.y - a.y || a.x - b.x)
      .map((l) => l.text)
      .join("\n");
    const limpio = limpiarTexto(raw);
    if (limpio.length > 40 && !esRuidoMaquetacion(limpio)) {
      const meta = extraerMetadatos(limpio, "");
      return [{ text: limpio, fecha: meta.fecha || undefined, hora: meta.hora || undefined }];
    }
    return [];
  }

  // 3) Para cada noticia, calculamos su "caja" de cuerpo: se extiende desde
  //    debajo del titular hasta el siguiente titular cuyo rango horizontal
  //    solape con el nuestro (esa es la frontera vertical real dentro del
  //    recuadro). Sólo se aceptan líneas cuyo tamaño sea coherente con el
  //    cuerpo (median ± 20%) y cuyo centro X caiga dentro del rango
  //    horizontal del titular; así evitamos absorber columnas de otras
  //    noticias, pies de foto pequeños o destacados grandes.
  const tolX = median * 2;
  const solapa = (a: Articulo, b: Articulo) =>
    !(a.xRight + tolX < b.xLeft || b.xRight + tolX < a.xLeft);

  const cuerpos: Linea[][] = articulos.map((art) => {
    let yTope = -Infinity;
    for (const otro of articulos) {
      if (otro === art) continue;
      if (otro.headlineTop >= art.headlineBottom) continue; // está por encima
      if (!solapa(art, otro)) continue;
      if (otro.headlineTop > yTope) yTope = otro.headlineTop;
    }
    const sizeMin = median * 0.85;
    const sizeMax = median * 1.2;
    return limpias.filter((l) => {
      if (consumidas.has(l)) return false;
      if (esHeadline(l)) return false;
      if (esLineaRuido(l.text)) return false;
      if (esEtiquetaSeccion(l.text) && l.size <= median * 1.3) return false;
      if (l.size < sizeMin || l.size > sizeMax) return false;
      if (l.y >= art.headlineBottom) return false;
      if (l.y <= yTope) return false;
      const cx = (l.x + l.xEnd) / 2;
      if (cx < art.xLeft - tolX || cx > art.xRight + tolX) return false;
      return true;
    });
  });

  // 4) Componer cada bloque respetando el orden de lectura: detectamos las
  //    columnas reales del artículo agrupando los x de sus propias líneas
  //    en clusters separados por huecos claros; después leemos columna por
  //    columna de izquierda a derecha, y dentro de cada una de arriba abajo.
  const bloques: { titulo?: string; text: string; fecha?: string; hora?: string }[] = [];
  for (let i = 0; i < articulos.length; i++) {
    const art = articulos[i];
    const lineasCuerpo = cuerpos[i];
    if (!lineasCuerpo.length) continue;

    // Detectamos las columnas reales por COBERTURA horizontal en vez de por
    // un umbral de hueco entre puntos de arranque de línea (ese método
    // fallaba cuando el pasillo real entre columnas era más estrecho que el
    // umbral, o se confundía con sangrías de inicio de párrafo). Marcamos
    // qué posiciones horizontales quedan cubiertas por el ancho completo
    // (x a xEnd) de alguna línea del cuerpo: el pasillo real entre columnas
    // es la única franja por la que ninguna línea llega a pasar nunca,
    // mientras que una sangría de primera línea sigue ocupando casi todo el
    // ancho de su columna y por tanto no deja un hueco de cobertura.
    const xLeftAll = Math.min(...lineasCuerpo.map((l) => l.x));
    const xRightAll = Math.max(...lineasCuerpo.map((l) => l.xEnd));
    const anchoTotal = Math.max(1, Math.ceil(xRightAll - xLeftAll));
    const cobertura = new Uint8Array(anchoTotal + 1);
    for (const l of lineasCuerpo) {
      const desde = Math.max(0, Math.round(l.x - xLeftAll));
      const hasta = Math.min(anchoTotal, Math.round(l.xEnd - xLeftAll));
      for (let b = desde; b <= hasta; b++) cobertura[b] = 1;
    }
    // Un hueco solo cuenta como pasillo real si es de al menos un ancho de
    // letra (evita ruido de redondeo) y dejaría contenido razonable a cada
    // lado (evita fragmentar por un hueco espurio de una sola línea corta).
    const huecoMin = Math.max(4, median * 0.8);
    const anchoColMin = median * 4;
    const colRangos: { desde: number; hasta: number }[] = [];
    let inicioCol = 0;
    let b = 0;
    while (b <= anchoTotal) {
      if (cobertura[b]) {
        b++;
        continue;
      }
      let finHueco = b;
      while (finHueco <= anchoTotal && !cobertura[finHueco]) finHueco++;
      const huecoAncho = finHueco - b;
      const colAncho = b - inicioCol;
      if (huecoAncho >= huecoMin && colAncho >= anchoColMin) {
        colRangos.push({ desde: inicioCol, hasta: b });
        inicioCol = finHueco;
      }
      b = finHueco;
    }
    colRangos.push({ desde: inicioCol, hasta: anchoTotal });

    const colIndex = (x: number) => {
      const rel = x - xLeftAll;
      for (let k = 0; k < colRangos.length; k++) {
        if (rel <= colRangos[k].hasta) return k;
      }
      return colRangos.length - 1;
    };

    lineasCuerpo.sort((a, b2) => {
      const ca = colIndex(a.x);
      const cb = colIndex(b2.x);
      if (ca !== cb) return ca - cb;
      return b2.y - a.y;
    });
    const raw = lineasCuerpo.map((l) => l.text).join("\n");
    const limpio = limpiarTexto(raw);

    if (limpio.length < 40 || esRuidoMaquetacion(limpio)) continue;
    const meta = extraerMetadatos(`${limpio}\n${art.titulo}`, "");
    bloques.push({
      titulo: art.titulo.replace(/\s+/g, " ").trim(),
      text: limpio,
      fecha: meta.fecha || undefined,
      hora: meta.hora || undefined,
    });
  }

  return bloques;
}

// Selector de zona sobre la miniatura de una página. Permite dibujar varios
// rectángulos y rotar la vista si el PDF está girado. Las coordenadas se
// mapean de píxeles del <img> a coordenadas de usuario del PDF (mismo
// espacio que los items nativos), teniendo en cuenta la rotación aplicada.
function RegionPicker({
  thumb,
  rects,
  rotation,
  onChange,
  onRotate,
}: {
  thumb: PageThumb;
  rects: PdfRect[];
  rotation: number;
  onChange: (rects: PdfRect[]) => void;
  onRotate: (rot: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const [vx0, vy0, vx1, vy1] = thumb.viewBox;
  const pdfW = vx1 - vx0;
  const pdfH = vy1 - vy0;
  // Rotación efectiva aplicada visualmente sobre la miniatura (0/90/180/270).
  const rot = ((rotation % 360) + 360) % 360;

  // Convierte un punto (px,py) del contenedor rotado a coords PDF.
  const toPdf = (px: number, py: number, w: number, h: number): { x: number; y: number } => {
    // El contenedor tiene dimensiones (w,h) tras rotación. Deshacemos la
    // rotación para volver al espacio del canvas original.
    let ux = px;
    let uy = py;
    let W = w;
    let H = h;
    if (rot === 90) {
      // El eje X del contenedor corresponde al eje Y inverso del canvas.
      ux = py;
      uy = w - px;
      W = h;
      H = w;
    } else if (rot === 180) {
      ux = w - px;
      uy = h - py;
    } else if (rot === 270) {
      ux = h - py;
      uy = px;
      W = h;
      H = w;
    }
    return {
      x: vx0 + (ux / W) * pdfW,
      y: vy1 - (uy / H) * pdfH,
    };
  };

  // Convierte un rect en coords PDF a estilo CSS % dentro del contenedor
  // (que ya está rotado visualmente).
  const toPct = (r: PdfRect) => {
    // Puntos del rect en espacio canvas (sin rotar)
    const ax = ((r.xMin - vx0) / pdfW) * 100;
    const ay = ((vy1 - r.yMax) / pdfH) * 100;
    const bx = ((r.xMax - vx0) / pdfW) * 100;
    const by = ((vy1 - r.yMin) / pdfH) * 100;
    // Aplicar rotación en %
    let l: number, t: number, rgt: number, btm: number;
    if (rot === 0) {
      l = ax;
      t = ay;
      rgt = 100 - bx;
      btm = 100 - by;
    } else if (rot === 90) {
      // (x,y) -> (100-y, x) en un cuadrado; pero contenedor rota, así que:
      // el contenedor rotado tiene ancho=alto original.
      l = 100 - by;
      t = ax;
      rgt = 100 - (100 - ay);
      btm = 100 - bx;
    } else if (rot === 180) {
      l = 100 - bx;
      t = 100 - by;
      rgt = ax;
      btm = ay;
    } else {
      l = ay;
      t = 100 - bx;
      rgt = 100 - by;
      btm = 100 - (100 - ax);
    }
    return {
      left: `${l}%`,
      top: `${t}%`,
      right: `${rgt}%`,
      bottom: `${btm}%`,
    };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const b = el.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const el = containerRef.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setDrag({ ...drag, x1: e.clientX - b.left, y1: e.clientY - b.top });
  };
  const onUp = () => {
    if (!drag) return;
    const el = containerRef.current;
    if (!el) {
      setDrag(null);
      return;
    }
    const b = el.getBoundingClientRect();
    const x0 = Math.max(0, Math.min(drag.x0, drag.x1));
    const y0 = Math.max(0, Math.min(drag.y0, drag.y1));
    const x1 = Math.min(b.width, Math.max(drag.x0, drag.x1));
    const y1 = Math.min(b.height, Math.max(drag.y0, drag.y1));
    setDrag(null);
    if (x1 - x0 < 10 || y1 - y0 < 10) return;
    const a = toPdf(x0, y0, b.width, b.height);
    const c = toPdf(x1, y1, b.width, b.height);
    const nuevo: PdfRect = {
      xMin: Math.min(a.x, c.x),
      xMax: Math.max(a.x, c.x),
      yMin: Math.min(a.y, c.y),
      yMax: Math.max(a.y, c.y),
    };
    onChange([...rects, nuevo]);
  };

  const overlay = drag
    ? {
        left: Math.min(drag.x0, drag.x1),
        top: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm font-medium">
          Página {thumb.page}
          {rects.length > 0 && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {rects.length} zona{rects.length === 1 ? "" : "s"} marcada
              {rects.length === 1 ? "" : "s"}
            </span>
          )}
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRotate((rot + 270) % 360)}
            title="Girar 90° a la izquierda"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRotate((rot + 90) % 360)}
            title="Girar 90° a la derecha"
          >
            <RotateCcw className="h-4 w-4 scale-x-[-1]" />
          </Button>
          {rects.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => onChange([])}>
              Limpiar zonas
            </Button>
          )}
        </div>
      </div>
      <div
        ref={containerRef}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        className="relative inline-block max-w-full cursor-crosshair select-none overflow-hidden rounded border bg-muted"
        style={{ touchAction: "none" }}
      >
        <img
          src={thumb.dataUrl}
          alt={`Página ${thumb.page}`}
          className="block max-w-full h-auto pointer-events-none origin-center"
          draggable={false}
          loading="lazy"
          style={{ transform: `rotate(${rot}deg)` }}
        />
        {rects.map((r, i) => (
          <div
            key={i}
            className="pointer-events-none absolute border-2 border-primary bg-primary/15"
            style={toPct(r)}
          >
            <span className="pointer-events-auto absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
              {i + 1}
            </span>
            <button
              type="button"
              onPointerDown={(e) => {
                e.stopPropagation();
                onChange(rects.filter((_, j) => j !== i));
              }}
              className="pointer-events-auto absolute -top-2 -left-2 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-[12px] leading-none text-destructive-foreground shadow"
              title="Eliminar zona"
            >
              ×
            </button>
          </div>
        ))}
        {overlay && (
          <div
            className="pointer-events-none absolute border-2 border-primary/70 bg-primary/10"
            style={overlay}
          />
        )}
      </div>
    </div>
  );
}

interface LibraryViewProps {
  noticias: SavedNoticia[];
  editingId: string | null;
  highlightId: string | null;
  onEdit: (id: string | null) => void;
  onDelete: (id: string) => void;
  onUpdate: (n: SavedNoticia) => void;
  onNew: () => void;
}

function LibraryView({
  noticias,
  editingId,
  highlightId,
  onEdit,
  onDelete,
  onUpdate,
  onNew,
}: LibraryViewProps) {
  const editing = noticias.find((n) => n.id === editingId) ?? null;
  const [draft, setDraft] = useState<SavedNoticia | null>(editing);
  useEffect(() => {
    setDraft(editing ? JSON.parse(JSON.stringify(editing)) : null);
  }, [editingId, editing]);

  if (editing && draft) {
    const updateBlock = (bid: string, patch: Partial<SavedBlock>) => {
      setDraft({
        ...draft,
        bloques: draft.bloques.map((b) => (b.id === bid ? { ...b, ...patch } : b)),
      });
    };
    const removeBlock = (bid: string) => {
      setDraft({ ...draft, bloques: draft.bloques.filter((b) => b.id !== bid) });
    };
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => onEdit(null)} className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Volver
            </Button>
            <CardTitle>Editar noticia</CardTitle>
          </div>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirm("¿Eliminar esta noticia de la biblioteca?")) {
                  onDelete(draft.id);
                  onEdit(null);
                }
              }}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              Eliminar
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onUpdate(draft);
                toast.success("Cambios guardados.");
                onEdit(null);
              }}
              className="gap-2"
            >
              <Save className="h-4 w-4" />
              Guardar cambios
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Periódico</Label>
              <Input
                value={draft.periodico}
                onChange={(e) => setDraft({ ...draft, periodico: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Titular</Label>
              <Input
                value={draft.titulo}
                onChange={(e) => setDraft({ ...draft, titulo: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Fecha</Label>
              <Input
                value={draft.fecha}
                onChange={(e) => setDraft({ ...draft, fecha: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Hora</Label>
              <Input
                value={draft.hora}
                onChange={(e) => setDraft({ ...draft, hora: e.target.value })}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-4">
            <h3 className="text-sm font-semibold">Bloques de texto ({draft.bloques.length})</h3>
            {draft.bloques.map((b) => (
              <div key={b.id} className="space-y-3 rounded-md border bg-muted/30 p-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-1 md:col-span-3">
                    <Label className="text-xs">Título del bloque</Label>
                    <Input
                      value={b.titulo}
                      onChange={(e) => updateBlock(b.id, { titulo: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Fecha</Label>
                    <Input
                      value={b.fecha}
                      onChange={(e) => updateBlock(b.id, { fecha: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Hora</Label>
                    <Input
                      value={b.hora}
                      onChange={(e) => updateBlock(b.id, { hora: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Página</Label>
                    <Input value={String(b.page)} disabled />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Texto</Label>
                  <Textarea
                    rows={8}
                    value={b.texto}
                    onChange={(e) => updateBlock(b.id, { texto: e.target.value })}
                  />
                </div>
                {(b.imagenPagina || b.imagenSeleccion) && (
                  <div className="grid gap-3 md:grid-cols-2">
                    {b.imagenPagina && (
                      <a href={b.imagenPagina} target="_blank" rel="noreferrer">
                        <img
                          src={b.imagenPagina}
                          alt={`Página ${b.page}`}
                          loading="lazy"
                          className="w-full rounded border"
                        />
                      </a>
                    )}
                    {b.imagenSeleccion && (
                      <a href={b.imagenSeleccion} target="_blank" rel="noreferrer">
                        <img
                          src={b.imagenSeleccion}
                          alt={`Selección página ${b.page}`}
                          loading="lazy"
                          className="w-full rounded border"
                        />
                      </a>
                    )}
                  </div>
                )}
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeBlock(b.id)}
                    className="gap-2 text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    Quitar bloque
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Biblioteca de noticias</CardTitle>
        <Button size="sm" onClick={onNew} className="gap-2">
          <FileUp className="h-4 w-4" />
          Nueva noticia
        </Button>
      </CardHeader>
      <CardContent>
        {noticias.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Todavía no has guardado ninguna noticia. Importa un PDF para empezar.
          </p>
        ) : (
          <div className="space-y-3">
            {noticias.map((n) => (
              <div
                key={n.id}
                className={`flex flex-col gap-3 rounded-md border p-4 md:flex-row md:items-center ${
                  n.id === highlightId ? "border-primary" : ""
                }`}
              >
                {n.bloques[0]?.imagenSeleccion || n.bloques[0]?.imagenPagina ? (
                  <img
                    src={n.bloques[0]?.imagenSeleccion ?? n.bloques[0]?.imagenPagina ?? ""}
                    alt=""
                    loading="lazy"
                    className="h-24 w-32 shrink-0 rounded border object-cover"
                  />
                ) : (
                  <div className="flex h-24 w-32 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground">
                    <Newspaper className="h-6 w-6" />
                  </div>
                )}
                <div className="flex-1">
                  <h3 className="font-semibold">{n.titulo || "(sin título)"}</h3>
                  <p className="text-xs text-muted-foreground">
                    {n.periodico} · {n.fecha || "fecha por determinar"} ·{" "}
                    {n.hora || "hora por determinar"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {n.bloques.length} bloque(s) · guardada el{" "}
                    {new Date(n.updatedAt).toLocaleString("es-ES")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onEdit(n.id)}
                    className="gap-2"
                  >
                    <Pencil className="h-4 w-4" />
                    Ver / editar
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (confirm("¿Eliminar esta noticia?")) onDelete(n.id);
                    }}
                    className="gap-2 text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SocidaPressApp() {
  const [stage, setStage] = useState<Stage>("form");
  const [metadata, setMetadata] = useState<Metadata>({
    periodico: "",
    titulo: "",
    fecha: "",
    hora: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [images, setImages] = useState<ExtractedImage[]>([]);
  const [textBlocks, setTextBlocks] = useState<ExtractedTextBlock[]>([]);
  const [selectedImgIds, setSelectedImgIds] = useState<Set<string>>(new Set());
  const [selectedTextIds, setSelectedTextIds] = useState<Set<string>>(new Set());
  const [thumbs, setThumbs] = useState<PageThumb[]>([]);
  const [pageImages, setPageImages] = useState<PageImage[]>([]);
  const [regions, setRegions] = useState<Record<number, PdfRect[]>>({});
  const [rotations, setRotations] = useState<Record<number, number>>({});
  const pdfRef = useRef<unknown>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Biblioteca persistente en localStorage
  const [saved, setSaved] = useState<SavedNoticia[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lastSavedId, setLastSavedId] = useState<string | null>(null);
  useEffect(() => {
    setSaved(cargarNoticias());
  }, []);
  const persist = useCallback((next: SavedNoticia[]) => {
    setSaved(next);
    guardarNoticias(next);
  }, []);

  const handleReset = () => {
    setStage("form");
    setFile(null);
    setImages([]);
    setTextBlocks([]);
    setSelectedImgIds(new Set());
    setSelectedTextIds(new Set());
    setMetadata({ periodico: "", titulo: "", fecha: "", hora: "" });
    setProgress(0);
    setProgressLabel("");
    setThumbs([]);
    setPageImages([]);
    setRegions({});
    setRotations({});
    pdfRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Carga el PDF, genera miniaturas y lleva al paso de selección de zona.
  const loadPdfForRegion = useCallback(async () => {
    if (!file) return;
    setStage("processing");
    setProgress(5);
    setProgressLabel("Cargando PDF…");
    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      const buf = await file.arrayBuffer();
      const pdf = await pdfjs.getDocument({ data: buf }).promise;
      pdfRef.current = pdf;
      const nuevas: PageThumb[] = [];
      const rotIniciales: Record<number, number> = {};
      for (let p = 1; p <= pdf.numPages; p++) {
        setProgressLabel(`Preparando página ${p} de ${pdf.numPages}…`);
        setProgress(10 + Math.round((p / pdf.numPages) * 80));
        const page = (await pdf.getPage(p)) as {
          rotate?: number;
          getViewport: (o: { scale: number; rotation?: number }) => {
            width: number;
            height: number;
            viewBox: number[];
          };
          render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => {
            promise: Promise<void>;
          };
        };
        const pdfRot = (((page.rotate ?? 0) % 360) + 360) % 360;
        rotIniciales[p] = pdfRot;
        // Renderizamos sin rotación adicional: la miniatura muestra el PDF
        // "tal cual" y la corrección se aplica visualmente con CSS transform.
        const vp = page.getViewport({ scale: 1.3, rotation: 0 });
        const canvas = document.createElement("canvas");
        canvas.width = vp.width;
        canvas.height = vp.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        nuevas.push({
          page: p,
          dataUrl: canvas.toDataURL("image/webp", 0.85),
          canvasWidth: vp.width,
          canvasHeight: vp.height,
          viewBox: vp.viewBox as [number, number, number, number],
          pdfRotation: pdfRot,
        });
      }
      setThumbs(nuevas);
      setRegions({});
      setRotations(rotIniciales);
      setProgress(100);
      setStage("region");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      toast.error(`No se ha podido cargar el PDF: ${msg}`);
      setStage("form");
    }
  }, [file]);

  const processPdf = useCallback(async () => {
    if (!file) return;
    setStage("processing");
    setProgress(2);
    setProgressLabel("Cargando librerías…");

    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();

      setProgressLabel("Leyendo PDF…");
      // Reutilizamos el documento ya cargado en el paso de "zona" si existe.
      type PdfDocLike = {
        numPages: number;
        getPage: (n: number) => Promise<unknown>;
        getMetadata?: () => Promise<{ info?: unknown }>;
      };
      const pdf: PdfDocLike =
        (pdfRef.current as PdfDocLike | null) ??
        (await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise);
      pdfRef.current = pdf;
      const numPages = pdf.numPages;

      const foundImages: ExtractedImage[] = [];
      const pageCanvases: {
        page: number;
        canvas: HTMLCanvasElement;
        rectsPx: { x: number; y: number; w: number; h: number }[];
        rotation: number;
      }[] = [];
      const nativePageTexts: { page: number; text: string }[] = [];
      const nativePageItems: { page: number; items: NativeItem[] }[] = [];
      let tituloDetectado = "";

      // Comprobamos SOLAPE del rectángulo con todo el ancho del fragmento de
      // texto, no solo si su punto de anclaje (la línea base) cae dentro.
      // Un párrafo con sangría colgante (p. ej. "■ Primera línea..." más a
      // la derecha que las líneas de continuación, que vuelven al margen
      // real) puede quedar con su punto de anclaje justo fuera de un
      // recuadro dibujado a mano ajustado a esa primera línea, perdiendo
      // así todo el resto del párrafo aunque se vea claramente dentro de
      // la zona recortada. El margen en Y cubre que el punto de anclaje es
      // la línea base: el propio texto se extiende algo por encima y por
      // debajo de ese punto (mayúsculas, tildes, rabillos de "g"/"j"/"p").
      const dentro = (it: NativeItem, r: PdfRect | null) => {
        if (!r) return true;
        const itXEnd = it.x + (it.width || it.size * it.str.length * 0.5);
        const margenY = Math.max(it.size * 0.5, 3);
        const solapaX = itXEnd >= r.xMin && it.x <= r.xMax;
        const solapaY = it.y <= r.yMax + margenY && it.y >= r.yMin - margenY;
        return solapaX && solapaY;
      };

      // Muchas apps de "escanear con el móvil" (Adobe Scan, CamScanner,
      // Genius Scan, Microsoft Lens...) generan un PDF con la foto de la
      // página como una única imagen y le incrustan SU PROPIO texto de OCR
      // por encima, indistinguible a primera vista de un texto nativo real.
      // Ese OCR suele ser bastante peor que el nuestro (sin el enderezado,
      // aplanado de luz, binarización Sauvola, doble pasada...), así que si
      // lo detectamos preferimos ignorarlo por completo y forzar nuestro
      // propio OCR, aunque el recuento de items nativos sea alto.
      let esAppDeEscaneo = false;
      try {
        const meta = await pdf.getMetadata?.();
        const info = (meta?.info ?? {}) as Record<string, unknown>;
        const textoMeta = `${info.Producer ?? ""} ${info.Creator ?? ""}`.toLowerCase();
        esAppDeEscaneo = /scan|camscanner|genius scan|microsoft lens|turboscan/.test(textoMeta);
      } catch {
        // sin metadatos: seguimos con la heurística estructural de abajo
      }
      const paginasEscaneadas = new Set<number>();

      // ¿Se han marcado zonas en alguna página? Si sí, solo procesamos las
      // páginas con zonas marcadas (el usuario quiere aislar noticias
      // concretas); en caso contrario, procesamos la página completa.
      const haySeleccion = Object.values(regions).some((rs) => rs && rs.length > 0);

      // 1) Render + extracción de imágenes por página
      for (let p = 1; p <= numPages; p++) {
        const rectsPdf = regions[p] || [];
        if (haySeleccion && rectsPdf.length === 0) continue;
        setProgressLabel(`Analizando página ${p} de ${numPages}…`);
        setProgress(5 + Math.round(((p - 1) / numPages) * 40));

        const page = (await pdf.getPage(p)) as {
          rotate?: number;
          getViewport: (o: { scale: number; rotation?: number }) => {
            width: number;
            height: number;
            viewBox: number[];
          };
          render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => {
            promise: Promise<void>;
          };
          getTextContent: () => Promise<{ items: unknown[] }>;
          getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
          objs: { get: (n: string, cb: (o: unknown) => void) => void };
        };
        // Aplicamos la rotación elegida por el usuario (o la intrínseca del
        // PDF si no ha tocado nada) para que el texto salga derecho.
        const userRot = rotations[p];
        const rotacion = (((userRot ?? page.rotate ?? 0) % 360) + 360) % 360;
        const viewport = page.getViewport({ scale: 2, rotation: rotacion });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        await page.render({ canvasContext: ctx, viewport }).promise;

        // Convertimos cada rect del usuario (coords PDF sin rotar) a
        // píxeles del canvas ya rotado.
        const [vx0, vy0, vx1, vy1] = viewport.viewBox as [number, number, number, number];
        const pdfW = vx1 - vx0;
        const pdfH = vy1 - vy0;
        const cw = canvas.width;
        const ch = canvas.height;
        const rectsPx: { x: number; y: number; w: number; h: number }[] = rectsPdf.map((r) => {
          // Cuatro esquinas en coords canvas para rotación=0 (Y baja hacia abajo)
          const ax0 = (r.xMin - vx0) / pdfW;
          const ax1 = (r.xMax - vx0) / pdfW;
          const ay0 = (vy1 - r.yMax) / pdfH;
          const ay1 = (vy1 - r.yMin) / pdfH;
          let l: number, t: number, w: number, h: number;
          if (rotacion === 0) {
            l = ax0 * cw;
            t = ay0 * ch;
            w = (ax1 - ax0) * cw;
            h = (ay1 - ay0) * ch;
          } else if (rotacion === 90) {
            // (x,y) -> (H - y, x). Canvas rotado tiene w=oldH, h=oldW.
            l = (1 - ay1) * cw;
            t = ax0 * ch;
            w = (ay1 - ay0) * cw;
            h = (ax1 - ax0) * ch;
          } else if (rotacion === 180) {
            l = (1 - ax1) * cw;
            t = (1 - ay1) * ch;
            w = (ax1 - ax0) * cw;
            h = (ay1 - ay0) * ch;
          } else {
            l = ay0 * cw;
            t = (1 - ax1) * ch;
            w = (ay1 - ay0) * cw;
            h = (ax1 - ax0) * ch;
          }
          return { x: l, y: t, w, h };
        });
        pageCanvases.push({ page: p, canvas, rectsPx, rotation: rotacion });

        // Extraer texto nativo del PDF (mucho más fiable que OCR).
        try {
          const tc = await page.getTextContent();
          type TItem = {
            str: string;
            width?: number;
            height?: number;
            transform?: number[];
            hasEOL?: boolean;
          };
          const rawItems = (tc.items as unknown[]).filter(
            (it): it is TItem => !!it && typeof (it as TItem).str === "string",
          );
          const nItems: NativeItem[] = rawItems.map((it) => {
            const tr = it.transform || [0, 0, 0, 0, 0, 0];
            return {
              str: it.str,
              x: tr[4] || 0,
              y: tr[5] || 0,
              size: it.height ?? Math.abs(tr[3] || 0),
              // Ancho real del fragmento (ya lo calcula pdf.js con la
              // información exacta de las fuentes); antes se estimaba a
              // ojo (tamaño × nº de caracteres × 0.5), lo que podía fallar
              // por varios puntos y confundir un hueco entre columnas con
              // un espacio dentro de la misma línea.
              width: it.width ?? 0,
              hasEOL: !!it.hasEOL,
            };
          });
          // Si el usuario marcó zonas, sólo aceptamos items que SOLAPEN con
          // ALGUNA de ellas (misma lógica de dentro(), no solo su punto de
          // anclaje: ver el comentario junto a la definición de dentro()).
          const nItemsFiltrados = rectsPdf.length
            ? nItems.filter((it) => rectsPdf.some((r) => dentro(it, r)))
            : nItems;
          nativePageItems.push({ page: p, items: nItemsFiltrados });

          // Detectamos páginas "foto + OCR incrustado" (apps de escanear
          // con el móvil): normalmente es UNA sola imagen a toda página en
          // vez de varias fotos sueltas de un PDF nativo. Sin metadatos de
          // la app, usamos una heurística estructural: poquísimas imágenes
          // pero muchísimo texto (todo el OCR de la app volcado palabra a
          // palabra), algo que un PDF digital de verdad no suele tener.
          let nImg = 0;
          try {
            const ops = await page.getOperatorList();
            const OPS = pdfjs.OPS;
            for (let i = 0; i < ops.fnArray.length; i++) {
              if (
                ops.fnArray[i] === OPS.paintImageXObject ||
                ops.fnArray[i] === OPS.paintImageXObjectRepeat
              ) {
                nImg++;
              }
            }
          } catch {
            // si no se puede leer la lista de operadores, asumimos 0 imágenes
          }
          if ((esAppDeEscaneo && nImg <= 2) || (nImg <= 1 && nItems.length > 200)) {
            paginasEscaneadas.add(p);
          }

          const pageStr = rawItems
            .map((it) => it.str + (it.hasEOL ? "\n" : " "))
            .join("")
            .replace(/[ \t]+\n/g, "\n")
            .trim();
          nativePageTexts.push({ page: p, text: pageStr });

          if (p === 1 && nItems.length && !paginasEscaneadas.has(p)) {
            const withSize = nItems
              .map((it) => ({ str: it.str.trim(), size: it.size }))
              .filter((x) => x.str.length > 0);
            if (withSize.length) {
              const maxSize = withSize.reduce((m, x) => Math.max(m, x.size), 0);
              const umbral = maxSize * 0.9;
              const tituloItems = withSize.filter((x) => x.size >= umbral);
              tituloDetectado = tituloItems
                .map((x) => x.str)
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
            }
          }
        } catch {
          // sin capa de texto -> nos apoyaremos en el OCR
        }

        try {
          const opList = await page.getOperatorList();
          const OPS = pdfjs.OPS;
          const seen = new Set<string>();
          for (let i = 0; i < opList.fnArray.length; i++) {
            const fn = opList.fnArray[i];
            if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
              const args = opList.argsArray[i];
              const name = args?.[0] as string | undefined;
              if (!name || seen.has(name)) continue;
              seen.add(name);
              try {
                const img: unknown = await new Promise((resolve) => {
                  try {
                    (
                      page as unknown as {
                        objs: { get: (n: string, cb: (o: unknown) => void) => void };
                      }
                    ).objs.get(name, resolve);
                  } catch {
                    resolve(null);
                  }
                });
                if (img && typeof img === "object") {
                  const typed = img as {
                    data?: Uint8ClampedArray | Uint8Array;
                    width?: number;
                    height?: number;
                    kind?: number;
                    bitmap?: ImageBitmap;
                  };
                  if (typed.bitmap) {
                    const c = document.createElement("canvas");
                    c.width = typed.bitmap.width;
                    c.height = typed.bitmap.height;
                    const cx = c.getContext("2d");
                    if (cx) {
                      cx.drawImage(typed.bitmap, 0, 0);
                      if (c.width >= 80 && c.height >= 80) {
                        foundImages.push({
                          id: `img-${p}-${foundImages.length}`,
                          page: p,
                          dataUrl: canvasToWebp(c),
                          width: c.width,
                          height: c.height,
                        });
                      }
                    }
                  } else if (typed.data && typed.width && typed.height) {
                    if (typed.width < 80 || typed.height < 80) continue;
                    const url = pdfImageToDataUrl({
                      data: typed.data,
                      width: typed.width,
                      height: typed.height,
                      kind: typed.kind,
                    });
                    if (url) {
                      foundImages.push({
                        id: `img-${p}-${foundImages.length}`,
                        page: p,
                        dataUrl: url,
                        width: typed.width,
                        height: typed.height,
                      });
                    }
                  }
                }
              } catch {
                // ignoramos imágenes que no podamos resolver
              }
            }
          }
        } catch {
          // sin lista de operaciones -> seguimos
        }
      }

      // Recorte de una zona rectangular sobre un canvas ya rotado.
      const recortar = (
        canvas: HTMLCanvasElement,
        r: { x: number; y: number; w: number; h: number },
      ): HTMLCanvasElement | null => {
        if (r.w < 20 || r.h < 20) return null;
        const c = document.createElement("canvas");
        c.width = Math.round(r.w);
        c.height = Math.round(r.h);
        const cctx = c.getContext("2d");
        if (!cctx) return null;
        cctx.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
        return c;
      };

      // Ancho objetivo (px) para el recorte de cada zona antes del OCR:
      // suficiente para que las letras del cuerpo de texto tengan un
      // tamaño cómodo para el motor, sin disparar la memoria.
      const ANCHO_OBJETIVO_ZONA = 3400;

      // Vuelve a renderizar una zona directamente desde el PDF a alta
      // resolución, en vez de recortar y ampliar el render de página
      // completa (que solo interpola, sin aportar información nueva).
      // Esto es lo que más mejora la nitidez del texto pequeño antes de
      // pasarlo por OCR: la letra sale nítida de verdad, no "estirada".
      const renderZonaDesdeOriginal = async (
        numPage: number,
        rectPdf: PdfRect,
        rotacion: number,
      ): Promise<HTMLCanvasElement | null> => {
        try {
          const pageAlta = (await pdf.getPage(numPage)) as {
            getViewport: (o: { scale: number; rotation?: number }) => {
              width: number;
              height: number;
              viewBox: number[];
            };
            render: (o: {
              canvasContext: CanvasRenderingContext2D;
              viewport: unknown;
              transform?: number[];
            }) => { promise: Promise<void> };
          };
          const anchoPdf = Math.max(1, rectPdf.xMax - rectPdf.xMin);
          const altoPdf = Math.max(1, rectPdf.yMax - rectPdf.yMin);
          const esVertical = rotacion === 90 || rotacion === 270;
          const anchoEnPantalla = esVertical ? altoPdf : anchoPdf;
          const scale = Math.min(9, Math.max(2, ANCHO_OBJETIVO_ZONA / anchoEnPantalla));
          const viewport = pageAlta.getViewport({ scale, rotation: rotacion });
          const [vx0, vy0, vx1, vy1] = viewport.viewBox as [number, number, number, number];
          const pdfW = vx1 - vx0;
          const pdfH = vy1 - vy0;
          const cw = viewport.width;
          const ch = viewport.height;
          const ax0 = (rectPdf.xMin - vx0) / pdfW;
          const ax1 = (rectPdf.xMax - vx0) / pdfW;
          const ay0 = (vy1 - rectPdf.yMax) / pdfH;
          const ay1 = (vy1 - rectPdf.yMin) / pdfH;
          let l: number, t: number, w: number, h: number;
          if (rotacion === 0) {
            l = ax0 * cw;
            t = ay0 * ch;
            w = (ax1 - ax0) * cw;
            h = (ay1 - ay0) * ch;
          } else if (rotacion === 90) {
            l = (1 - ay1) * cw;
            t = ax0 * ch;
            w = (ay1 - ay0) * cw;
            h = (ax1 - ax0) * ch;
          } else if (rotacion === 180) {
            l = (1 - ax1) * cw;
            t = (1 - ay1) * ch;
            w = (ax1 - ax0) * cw;
            h = (ay1 - ay0) * ch;
          } else {
            l = ay0 * cw;
            t = (1 - ax1) * ch;
            w = (ay1 - ay0) * cw;
            h = (ax1 - ax0) * ch;
          }
          if (w < 20 || h < 20) return null;
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(w);
          canvas.height = Math.round(h);
          const ctx = canvas.getContext("2d");
          if (!ctx) return null;
          // Desplazamos el origen para dibujar (y reservar memoria) solo la
          // zona recortada, no la página completa a esta resolución.
          await pageAlta.render({
            canvasContext: ctx,
            viewport,
            transform: [1, 0, 0, 1, -l, -t],
          }).promise;
          return canvas;
        } catch {
          return null;
        }
      };

      // Aplanado de iluminación: las fotos hechas con el móvil casi nunca
      // tienen luz uniforme (sombra de la mano o del propio móvil, flash
      // lateral, foco más fuerte en el centro que en los bordes...).
      // Estimamos la "luz de fondo" con un desenfoque muy amplio -mediante
      // imagen integral, así el radio no penaliza el rendimiento- que borra
      // el texto pero conserva el degradado de luz, y normalizamos cada
      // píxel respecto a esa estimación. Así una sombra en una esquina no
      // hace que esa zona se binarice mal mientras el resto sale bien.
      const aplanarIluminacion = (
        gris: Uint8ClampedArray,
        w: number,
        h: number,
      ): Uint8ClampedArray => {
        const integral = new Float64Array((w + 1) * (h + 1));
        for (let y = 0; y < h; y++) {
          let fila = 0;
          for (let x = 0; x < w; x++) {
            fila += gris[y * w + x];
            integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + fila;
          }
        }
        // Radio amplio: suficiente para difuminar letras y párrafos enteros
        // y quedarnos solo con el degradado de luz de fondo del papel.
        const radio = Math.max(15, Math.round(Math.min(w, h) / 6));
        const salida = new Uint8ClampedArray(w * h);
        for (let y = 0; y < h; y++) {
          const y0 = Math.max(0, y - radio);
          const y1 = Math.min(h - 1, y + radio);
          for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - radio);
            const x1 = Math.min(w - 1, x + radio);
            const area = (y1 - y0 + 1) * (x1 - x0 + 1);
            const suma =
              integral[(y1 + 1) * (w + 1) + (x1 + 1)] -
              integral[y0 * (w + 1) + (x1 + 1)] -
              integral[(y1 + 1) * (w + 1) + x0] +
              integral[y0 * (w + 1) + x0];
            const fondo = suma / area;
            // Normalizamos contra un gris de referencia cercano al blanco
            // del papel para no oscurecer las zonas ya bien iluminadas.
            salida[y * w + x] = (gris[y * w + x] / Math.max(1, fondo)) * 200;
          }
        }
        return salida;
      };

      // Corrección de inclinación (deskew): a diferencia de un escáner
      // plano, una foto hecha a mano casi nunca sale perfectamente recta.
      // Probamos un rango pequeño de ángulos sobre una copia reducida (para
      // que sea rápido) y nos quedamos con el que alinea mejor las líneas
      // de texto -perfil de proyección: la variable con más contraste entre
      // líneas de texto y espacios entre líneas es la que está más recta-.
      const corregirInclinacion = (canvas: HTMLCanvasElement): HTMLCanvasElement => {
        const wOrig = canvas.width;
        const hOrig = canvas.height;
        const anchoAnalisis = 500;
        const factor = Math.min(1, anchoAnalisis / wOrig);
        const aw = Math.max(1, Math.round(wOrig * factor));
        const ah = Math.max(1, Math.round(hOrig * factor));
        const mini = document.createElement("canvas");
        mini.width = aw;
        mini.height = ah;
        const mctx = mini.getContext("2d");
        if (!mctx) return canvas;
        mctx.drawImage(canvas, 0, 0, aw, ah);
        const img = mctx.getImageData(0, 0, aw, ah);
        const d = img.data;
        let suma = 0;
        const gris = new Uint8ClampedArray(aw * ah);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) {
          const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
          gris[j] = g;
          suma += g;
        }
        const media = suma / gris.length;
        const oscuros: { x: number; y: number }[] = [];
        for (let y = 0; y < ah; y++) {
          for (let x = 0; x < aw; x++) {
            if (gris[y * aw + x] < media * 0.82) oscuros.push({ x, y });
          }
        }
        // Zona casi vacía de texto: no merece la pena buscar un ángulo.
        if (oscuros.length < 200) return canvas;

        let mejorAngulo = 0;
        let mejorVarianza = -1;
        const cx = aw / 2;
        const cy = ah / 2;
        for (let angDeg = -6; angDeg <= 6; angDeg += 0.5) {
          const rad = (angDeg * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const filas = new Float64Array(ah);
          for (const p of oscuros) {
            const rx = p.x - cx;
            const ry = p.y - cy;
            const ryRot = rx * sin + ry * cos;
            const fila = Math.round(ryRot + cy);
            if (fila >= 0 && fila < ah) filas[fila]++;
          }
          const m = filas.reduce((a, b) => a + b, 0) / ah;
          let varianza = 0;
          for (let i = 0; i < ah; i++) varianza += (filas[i] - m) * (filas[i] - m);
          varianza /= ah;
          if (varianza > mejorVarianza) {
            mejorVarianza = varianza;
            mejorAngulo = angDeg;
          }
        }

        // Ángulo despreciable: no merece la pena rotar (evitamos introducir
        // artefactos de interpolación en fotos que ya salieron rectas).
        if (Math.abs(mejorAngulo) < 0.3) return canvas;

        const rad = (mejorAngulo * Math.PI) / 180;
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const nw = Math.round(wOrig * cos + hOrig * sin);
        const nh = Math.round(wOrig * sin + hOrig * cos);
        const out = document.createElement("canvas");
        out.width = nw;
        out.height = nh;
        const octx = out.getContext("2d");
        if (!octx) return canvas;
        octx.fillStyle = "#ffffff";
        octx.fillRect(0, 0, nw, nh);
        octx.translate(nw / 2, nh / 2);
        octx.rotate(rad);
        octx.drawImage(canvas, -wOrig / 2, -hOrig / 2);
        return out;
      };

      // Mejora de la zona seleccionada: se redimensiona a un ancho objetivo
      // (para que las letras tengan tamaño suficiente) y se ajustan luz y
      // color -> gris + estirado de niveles por percentiles + gamma.
      // Devuelve una imagen legible y agradable a la vista.
      const mejorarZona = (canvas: HTMLCanvasElement, anchoObjetivo = 2000): HTMLCanvasElement => {
        const escala = Math.min(4, Math.max(1, anchoObjetivo / canvas.width));
        const c = document.createElement("canvas");
        c.width = Math.round(canvas.width * escala);
        c.height = Math.round(canvas.height * escala);
        const cx = c.getContext("2d");
        if (!cx) return canvas;
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = "high";
        cx.drawImage(canvas, 0, 0, c.width, c.height);

        const img = cx.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        const w2 = c.width;
        const h2 = c.height;
        const grisesCrudos = new Uint8ClampedArray(w2 * h2);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) {
          grisesCrudos[j] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
        }
        // Corregimos primero el degradado de luz (ver aplanarIluminacion);
        // el histograma y el contraste se calculan ya sobre esa versión.
        const grises = aplanarIluminacion(grisesCrudos, w2, h2);
        // Histograma de luminancia para calcular percentiles 2% y 98%.
        const hist = new Uint32Array(256);
        for (let j = 0; j < grises.length; j++) hist[grises[j]]++;
        const total = grises.length;
        const corte = Math.max(1, Math.round(total * 0.02));
        let lo = 0;
        let acc = 0;
        while (lo < 255 && acc + hist[lo] < corte) {
          acc += hist[lo];
          lo++;
        }
        let hi = 255;
        acc = 0;
        while (hi > 0 && acc + hist[hi] < corte) {
          acc += hist[hi];
          hi--;
        }
        if (hi - lo < 20) {
          lo = 0;
          hi = 255;
        }
        const rango = hi - lo;
        // Tabla de conversión: niveles + gamma 0,9 (aclara ligeramente el fondo).
        const lut = new Uint8ClampedArray(256);
        for (let v = 0; v < 256; v++) {
          const n = Math.min(1, Math.max(0, (v - lo) / rango));
          lut[v] = Math.round(Math.pow(n, 0.9) * 255);
        }
        const salidaGris = new Uint8ClampedArray(w2 * h2);
        for (let j = 0; j < grises.length; j++) {
          salidaGris[j] = lut[grises[j]];
        }
        // Enfoque suave (unsharp mask) para realzar los trazos finos de las
        // letras tras el reescalado, sin exagerar el ruido de fondo.
        const nitida = new Uint8ClampedArray(w2 * h2);
        const cantidad = 0.6;
        for (let y = 0; y < h2; y++) {
          const y0 = y > 0 ? y - 1 : y;
          const y1 = y < h2 - 1 ? y + 1 : y;
          for (let x = 0; x < w2; x++) {
            const x0 = x > 0 ? x - 1 : x;
            const x1 = x < w2 - 1 ? x + 1 : x;
            const media =
              (salidaGris[y0 * w2 + x0] +
                salidaGris[y0 * w2 + x] +
                salidaGris[y0 * w2 + x1] +
                salidaGris[y * w2 + x0] +
                salidaGris[y * w2 + x] +
                salidaGris[y * w2 + x1] +
                salidaGris[y1 * w2 + x0] +
                salidaGris[y1 * w2 + x] +
                salidaGris[y1 * w2 + x1]) /
              9;
            const idx = y * w2 + x;
            nitida[idx] = salidaGris[idx] + cantidad * (salidaGris[idx] - media);
          }
        }
        for (let i = 0, j = 0; i < d.length; i += 4, j++) {
          const v = nitida[j];
          d[i] = d[i + 1] = d[i + 2] = v;
          d[i + 3] = 255;
        }
        cx.putImageData(img, 0, 0);
        return c;
      };

      // Filtro de mediana 3x3 sobre el canal de gris: elimina el punteado
      // de trama de la impresión de periódico (halftone) sin difuminar el
      // trazo de las letras, que es lo que ocurriría con un desenfoque
      // gaussiano. Reduce mucho el ruido que confunde al OCR.
      const mediana3x3 = (valores: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray => {
        const out = new Uint8ClampedArray(w * h);
        const ventana = new Uint8ClampedArray(9);
        for (let y = 0; y < h; y++) {
          const y0 = y > 0 ? y - 1 : 0;
          const y1 = y < h - 1 ? y + 1 : h - 1;
          for (let x = 0; x < w; x++) {
            const x0 = x > 0 ? x - 1 : 0;
            const x1 = x < w - 1 ? x + 1 : w - 1;
            let n = 0;
            for (let yy = y0; yy <= y1; yy++) {
              for (let xx = x0; xx <= x1; xx++) ventana[n++] = valores[yy * w + xx];
            }
            const sub = ventana.subarray(0, n).slice();
            sub.sort();
            out[y * w + x] = sub[Math.floor(n / 2)];
          }
        }
        return out;
      };

      // Binarización adaptativa tipo Sauvola: el umbral usa la media Y la
      // desviación típica locales (no solo la media), lo que la hace mucho
      // más robusta ante sombras irregulares de escaneo o páginas dobladas
      // que un umbral fijo sobre la media. Se aplica solo a la copia que
      // se manda al OCR, no a la que se guarda para el registro.
      const binarizarParaOcr = (canvas: HTMLCanvasElement): HTMLCanvasElement => {
        const cx = canvas.getContext("2d");
        if (!cx) return canvas;
        const w = canvas.width;
        const h = canvas.height;
        const img = cx.getImageData(0, 0, w, h);
        const d = img.data;
        const gris = new Uint8ClampedArray(w * h);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) gris[j] = d[i];
        const base = mediana3x3(gris, w, h);

        const integral = new Float64Array((w + 1) * (h + 1));
        const integralSq = new Float64Array((w + 1) * (h + 1));
        for (let y = 0; y < h; y++) {
          let fila = 0;
          let filaSq = 0;
          for (let x = 0; x < w; x++) {
            const v = base[y * w + x];
            fila += v;
            filaSq += v * v;
            integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + fila;
            integralSq[(y + 1) * (w + 1) + (x + 1)] = integralSq[y * (w + 1) + (x + 1)] + filaSq;
          }
        }
        const radio = Math.max(8, Math.round(Math.min(w, h) / 40));
        const k = 0.28; // sensibilidad Sauvola: más alto = más agresivo con sombras
        const R = 128; // rango dinámico esperado de la desviación típica
        const out = document.createElement("canvas");
        out.width = w;
        out.height = h;
        const ox = out.getContext("2d");
        if (!ox) return canvas;
        const salida = ox.createImageData(w, h);
        const so = salida.data;
        for (let y = 0; y < h; y++) {
          const y0 = Math.max(0, y - radio);
          const y1 = Math.min(h - 1, y + radio);
          for (let x = 0; x < w; x++) {
            const x0 = Math.max(0, x - radio);
            const x1 = Math.min(w - 1, x + radio);
            const area = (y1 - y0 + 1) * (x1 - x0 + 1);
            const suma =
              integral[(y1 + 1) * (w + 1) + (x1 + 1)] -
              integral[y0 * (w + 1) + (x1 + 1)] -
              integral[(y1 + 1) * (w + 1) + x0] +
              integral[y0 * (w + 1) + x0];
            const sumaSq =
              integralSq[(y1 + 1) * (w + 1) + (x1 + 1)] -
              integralSq[y0 * (w + 1) + (x1 + 1)] -
              integralSq[(y1 + 1) * (w + 1) + x0] +
              integralSq[y0 * (w + 1) + x0];
            const media = suma / area;
            const varianza = Math.max(0, sumaSq / area - media * media);
            const desv = Math.sqrt(varianza);
            const umbral = media * (1 + k * (desv / R - 1));
            const i = (y * w + x) * 4;
            const v = base[y * w + x] < umbral ? 0 : 255;
            so[i] = so[i + 1] = so[i + 2] = v;
            so[i + 3] = 255;
          }
        }
        ox.putImageData(salida, 0, 0);
        return out;
      };

      // Imagen completa de cada página procesada (prueba visual).
      const pageImgs: PageImage[] = pageCanvases.map(({ page, canvas }) => ({
        page,
        fullDataUrl: canvas.toDataURL("image/webp", 0.85),
      }));

      // 2) Construimos la lista de ZONAS a procesar. Cada zona marcada por el
      //    usuario es una unidad independiente (su propio título, fecha, hora
      //    y bloque de texto). Si no hay zonas, la página completa es la zona.
      type Zona = {
        page: number;
        zona: number;
        rectPdf: PdfRect | null;
        recorte: HTMLCanvasElement | null;
        cropDataUrl?: string;
      };
      const zonas: Zona[] = [];
      for (const { page, canvas, rectsPx, rotation } of pageCanvases) {
        const rectsPdf = regions[page] || [];
        if (rectsPx.length) {
          for (let i = 0; i < rectsPx.length; i++) {
            const r = rectsPx[i];
            const rectPdf = rectsPdf[i] ?? null;
            setProgressLabel(`Preparando zona ${i + 1} de la página ${page}…`);
            // Preferimos volver a renderizar la zona directamente desde el
            // PDF a alta resolución (nitidez real); si no es posible,
            // recurrimos al recorte + ampliación del render de página.
            const altaRes = rectPdf ? await renderZonaDesdeOriginal(page, rectPdf, rotation) : null;
            const bruto = altaRes ?? recortar(canvas, r);
            const enderezado = bruto ? corregirInclinacion(bruto) : null;
            const mejorado = enderezado
              ? mejorarZona(enderezado, altaRes ? enderezado.width : 2000)
              : null;
            zonas.push({
              page,
              zona: i + 1,
              rectPdf,
              recorte: mejorado,
              cropDataUrl: mejorado ? mejorado.toDataURL("image/webp", 0.9) : undefined,
            });
          }
        } else {
          zonas.push({ page, zona: 1, rectPdf: null, recorte: canvas });
        }
      }
      // La primera zona de cada página queda también como recorte resumen.
      for (const pi of pageImgs) {
        const z = zonas.find((x) => x.page === pi.page && x.cropDataUrl);
        if (z) pi.cropDataUrl = z.cropDataUrl;
      }
      setPageImages(pageImgs);

      // 3) Extracción por zona: texto nativo del PDF si existe dentro de la
      //    zona; si no, OCR de alta precisión sobre el recorte mejorado.
      const blocks: ExtractedTextBlock[] = [];
      const pagesText: { page: number; text: string }[] = [];

      // Preparamos el OCR solo si alguna zona lo necesita.
      type OcrWorker = {
        recognize: (i: unknown) => Promise<{ data: { text?: string; confidence?: number } }>;
        terminate: () => Promise<unknown>;
        setParameters?: (p: Record<string, string>) => Promise<void>;
      };
      let worker: OcrWorker | null = null;
      const obtenerWorker = async (): Promise<OcrWorker> => {
        if (worker) return worker;
        setProgressLabel("Preparando OCR…");
        const tesseract = await import("tesseract.js");
        const w = (await tesseract.createWorker("spa", 1)) as unknown as OcrWorker;
        try {
          await w.setParameters?.({
            // "3" = segmentación totalmente automática: detecta columnas y
            // bloques de texto y respeta su orden de lectura (columna
            // izquierda completa y luego la derecha). Con "6" (bloque único)
            // el motor leía línea a línea saltando entre columnas y mezclaba
            // las frases de una noticia a varias columnas.
            tessedit_pageseg_mode: "3",
            preserve_interword_spaces: "1",
            user_defined_dpi: "300",
          });
        } catch {
          // versiones antiguas pueden no aceptar todos los parámetros
        }
        worker = w;
        return w;
      };

      // Muchas cabeceras de periódico llevan texto claro sobre fondo de
      // color (p. ej. "SPORT" en blanco sobre una barra roja); el OCR
      // asume por defecto letra oscura sobre fondo claro y no la lee
      // aunque se vea perfectamente. Probamos también la versión invertida
      // y añadimos ambos resultados (los patrones de fecha/periódico que
      // buscamos después no se ven afectados por el texto de más).
      const invertir = (canvas: HTMLCanvasElement): HTMLCanvasElement => {
        const out = document.createElement("canvas");
        out.width = canvas.width;
        out.height = canvas.height;
        const octx = out.getContext("2d");
        const cctx = canvas.getContext("2d");
        if (!octx || !cctx) return canvas;
        const img = cctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = 255 - d[i];
          d[i + 1] = 255 - d[i + 1];
          d[i + 2] = 255 - d[i + 2];
        }
        octx.putImageData(img, 0, 0);
        return out;
      };

      // A diferencia del texto nativo (donde separamos columnas por huecos
      // reales entre líneas), el camino de OCR no tenía ninguna separación
      // de columnas propia: dependía de que Tesseract la adivinara sola, y
      // en columnas estrechas de periódico no lo hace bien (mezcla texto de
      // una columna con la de al lado). Lo hacemos en dos fases:
      //  1) Separamos el recorte en BLOQUES horizontales por huecos reales
      //     en blanco entre líneas (título, entradilla, cada párrafo del
      //     cuerpo, tabla...). Si no se hiciera esto, un título o una tabla
      //     a todo lo ancho "taparían" el hueco real entre columnas del
      //     cuerpo en cualquier análisis que mirase toda la altura junta.
      //  2) Dentro de cada bloque (ya sin esa contaminación), buscamos
      //     huecos VERTICALES de columna por cobertura de tinta.
      const dividirEnColumnas = (canvas: HTMLCanvasElement): HTMLCanvasElement[] => {
        const cx = canvas.getContext("2d");
        if (!cx) return [canvas];
        const w = canvas.width;
        const h = canvas.height;
        const img = cx.getImageData(0, 0, w, h);
        const d = img.data;
        const gris = new Uint8ClampedArray(w * h);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) gris[j] = d[i];
        const ordenado = Uint8ClampedArray.from(gris).sort();
        const p40 = ordenado[Math.floor(ordenado.length * 0.4)];

        // Fase 1: bloques horizontales por huecos reales entre líneas.
        const filaTieneTinta = new Uint8Array(h);
        for (let y = 0; y < h; y++) {
          let cuenta = 0;
          for (let x = 0; x < w; x++) if (gris[y * w + x] < p40) cuenta++;
          filaTieneTinta[y] = cuenta >= w * 0.01 ? 1 : 0;
        }
        const bloquesCrudos: { y0: number; y1: number }[] = [];
        let y = 0;
        while (y < h) {
          if (!filaTieneTinta[y]) {
            y++;
            continue;
          }
          const y0 = y;
          while (y < h && filaTieneTinta[y]) y++;
          bloquesCrudos.push({ y0, y1: y });
        }
        if (!bloquesCrudos.length) return [canvas];
        // Altura de línea aproximada (mediana), para fusionar líneas del
        // mismo párrafo sin fusionar párrafos distintos entre sí.
        const alturas = bloquesCrudos.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
        const alturaLinea = alturas[Math.floor(alturas.length / 2)] || 15;
        const bloques: { y0: number; y1: number }[] = [{ ...bloquesCrudos[0] }];
        for (const b of bloquesCrudos.slice(1)) {
          const ultimo = bloques[bloques.length - 1];
          if (b.y0 - ultimo.y1 < alturaLinea) {
            ultimo.y1 = b.y1;
          } else {
            bloques.push({ ...b });
          }
        }

        // Fase 2: dentro de cada bloque, buscamos columnas por cobertura de
        // tinta. Aquí el umbral es más alto (~10% de la altura del bloque)
        // porque, sin elementos de otro tipo contaminando, un hueco real
        // entre columnas debe estar casi vacío durante casi todo el bloque.
        const huecoMin = Math.max(6, Math.round(w * 0.015));
        const anchoColMin = Math.max(20, Math.round(w * 0.08));
        // Guardamos también el índice de columna (0=izda, 1=siguiente...) y
        // la altura del bloque, para poder ordenar al final por COLUMNA
        // primero y no por bloque: si no, leeríamos "izda del párrafo 1,
        // derecha del párrafo 1, izda del párrafo 2..." en vez de toda la
        // columna izquierda seguida de toda la derecha.
        const piezas: { canvas: HTMLCanvasElement; columna: number; y0: number }[] = [];
        for (const bloque of bloques) {
          const altoBloque = bloque.y1 - bloque.y0;
          const cobertura = new Float64Array(w);
          for (let yy = bloque.y0; yy < bloque.y1; yy++) {
            for (let x = 0; x < w; x++) {
              if (gris[yy * w + x] < p40) cobertura[x]++;
            }
          }
          const minTinta = Math.max(1, altoBloque * 0.1);
          const rangos: { desde: number; hasta: number }[] = [];
          let inicio = 0;
          let x = 0;
          while (x < w) {
            if (cobertura[x] >= minTinta) {
              x++;
              continue;
            }
            let finHueco = x;
            while (finHueco < w && cobertura[finHueco] < minTinta) finHueco++;
            const huecoAncho = finHueco - x;
            const colAncho = x - inicio;
            if (huecoAncho >= huecoMin && colAncho >= anchoColMin) {
              rangos.push({ desde: inicio, hasta: x });
              inicio = finHueco;
            }
            x = finHueco;
          }
          rangos.push({ desde: inicio, hasta: w });
          const valido =
            rangos.length >= 2 && rangos.every((r) => r.hasta - r.desde >= anchoColMin);
          const tramos = valido ? rangos : [{ desde: 0, hasta: w }];
          tramos.forEach((t, columna) => {
            const c = document.createElement("canvas");
            c.width = Math.max(1, t.hasta - t.desde);
            c.height = altoBloque;
            const cctx = c.getContext("2d");
            if (cctx) {
              cctx.drawImage(
                canvas,
                t.desde,
                bloque.y0,
                c.width,
                altoBloque,
                0,
                0,
                c.width,
                altoBloque,
              );
            }
            piezas.push({ canvas: c, columna, y0: bloque.y0 });
          });
        }
        if (!piezas.length) return [canvas];
        // Ordenamos por COLUMNA primero y por altura después: así se lee
        // toda la columna izquierda de arriba abajo y luego toda la
        // derecha, en vez de alternar entre columnas bloque a bloque.
        piezas.sort((a, b) => a.columna - b.columna || a.y0 - b.y0);
        return piezas.map((p) => p.canvas);
      };

      // Además de las zonas que marca el usuario, intentamos leer por OCR
      // la franja superior de cada página (donde muchos periódicos ponen
      // su cabecera con el nombre y la fecha), para poder detectar
      // periódico y fecha aunque el recorte de la noticia no incluya esa
      // cabecera. Solo hace falta en páginas sin texto nativo (escaneadas
      // o capturas de pantalla), que es justo cuando más se necesita.
      const headerTexts: string[] = [];
      for (const { page, canvas } of pageCanvases) {
        const nativa = nativePageItems.find((n) => n.page === page);
        if ((nativa?.items.length ?? 0) > 20 && !paginasEscaneadas.has(page)) continue; // ya hay texto nativo fiable
        setProgressLabel(`Buscando cabecera en la página ${page}…`);
        const alto = Math.max(20, Math.round(canvas.height * 0.09));
        const franja = document.createElement("canvas");
        franja.width = canvas.width;
        franja.height = alto;
        const fctx = franja.getContext("2d");
        if (!fctx) continue;
        fctx.drawImage(canvas, 0, 0, canvas.width, alto, 0, 0, canvas.width, alto);
        try {
          const w = await obtenerWorker();
          const mejorada = mejorarZona(franja, franja.width);
          const { data: dataNormal } = await w.recognize(mejorada);
          if (dataNormal.text) headerTexts.push(dataNormal.text);
          const { data: dataInv } = await w.recognize(invertir(mejorada));
          if (dataInv.text) headerTexts.push(dataInv.text);
        } catch {
          // si falla el OCR de la cabecera, seguimos sin ese dato
        }

        // Algunos periódicos (AS) ponen la fecha en una franja vertical
        // pegada al margen izquierdo en vez de arriba del todo. Probamos
        // también esa franja, girada en los dos sentidos posibles (no
        // sabemos a priori hacia qué lado se lee).
        const anchoMargen = Math.max(20, Math.round(canvas.width * 0.06));
        const margen = document.createElement("canvas");
        margen.width = anchoMargen;
        margen.height = canvas.height;
        const mctx = margen.getContext("2d");
        if (!mctx) continue;
        mctx.drawImage(canvas, 0, 0, anchoMargen, canvas.height, 0, 0, anchoMargen, canvas.height);
        const mejoradaMargen = mejorarZona(margen, margen.width);
        for (const giro of [90, -90]) {
          try {
            const rotado = document.createElement("canvas");
            rotado.width = mejoradaMargen.height;
            rotado.height = mejoradaMargen.width;
            const rctx = rotado.getContext("2d");
            if (!rctx) continue;
            rctx.translate(rotado.width / 2, rotado.height / 2);
            rctx.rotate((giro * Math.PI) / 180);
            rctx.drawImage(mejoradaMargen, -mejoradaMargen.width / 2, -mejoradaMargen.height / 2);
            const w = await obtenerWorker();
            const { data } = await w.recognize(rotado);
            if (data.text) headerTexts.push(data.text);
          } catch {
            // si falla el OCR del margen, seguimos sin ese dato
          }
        }
      }

      for (let zi = 0; zi < zonas.length; zi++) {
        const z = zonas[zi];
        setProgressLabel(
          `Extrayendo página ${z.page} · zona ${z.zona} (${zi + 1}/${zonas.length})…`,
        );
        setProgress(50 + Math.round((zi / zonas.length) * 45));

        const nativa = nativePageItems.find((n) => n.page === z.page);
        const itemsZona = (nativa?.items ?? []).filter((it) => dentro(it, z.rectPdf));

        let titulo = "";
        let texto = "";
        // Si la página es "foto + OCR incrustado" (ver paginasEscaneadas),
        // ignoramos ese texto aunque haya muchos items: es el OCR de la
        // app de escaneo, normalmente peor que el nuestro, y preferimos
        // pasar directamente por nuestro propio pipeline de OCR.
        if (itemsZona.length > 20 && !paginasEscaneadas.has(z.page)) {
          const bloques = extraerBloquesNativos(itemsZona);
          titulo = bloques.find((b) => b.titulo)?.titulo ?? "";
          texto = bloques
            .map((b) => b.text)
            .filter(Boolean)
            .join("\n\n");
        }

        if (!texto && z.recorte) {
          const w = await obtenerWorker();
          // El motor LSTM de Tesseract rinde mejor, en la práctica, sobre
          // la imagen en gris con luz ya corregida que sobre una versión
          // binarizada a la fuerza: en fotos reales de periódico impreso,
          // binarizar convierte el grano/trama del papel en ruido de sal y
          // pimienta que confunde al motor más de lo que ayuda. Lo medimos
          // con datos reales (confianza media ~88 en gris frente a ~68
          // binarizado en la misma noticia), así que probamos primero el
          // gris y solo recurrimos a la binarizada si la confianza es baja.
          const recognizeMejor = async (recorte: HTMLCanvasElement) => {
            const { data: dataGris } = await w.recognize(recorte);
            let t = (dataGris.text || "").trim();
            let conf = dataGris.confidence ?? 0;
            if (conf < 75) {
              const { data: dataBin } = await w.recognize(binarizarParaOcr(recorte));
              const confBin = dataBin.confidence ?? 0;
              if (confBin > conf) {
                t = (dataBin.text || "").trim();
                conf = confBin;
              }
            }
            return t;
          };
          // Dividimos en columnas por huecos reales de tinta (igual que
          // con el texto nativo) antes de pasar por OCR, para no depender
          // de que Tesseract adivine solo el orden de lectura en columnas
          // estrechas de periódico.
          const columnas = dividirEnColumnas(z.recorte);
          const textos: string[] = [];
          for (const col of columnas) {
            const t = await recognizeMejor(col);
            if (t) textos.push(t);
          }
          const bruto = textos.join("\n");
          pagesText.push({ page: z.page, text: bruto });
          const lineas = bruto
            .split(/\n+/g)
            .map((s) => limpiarTexto(s))
            .filter((s) => s.length > 0 && !esLineaRuido(s));
          if (!titulo && lineas.length) {
            const cand = lineas.find((l) => l.length >= 8 && l.length <= 120);
            if (cand) titulo = cand;
          }
          texto = bruto
            .split(/\n\s*\n+/g)
            .map((s) => limpiarTexto(s))
            .filter((s) => s.length > 25 && !esRuidoMaquetacion(s))
            .join("\n\n");
        }

        if (!texto && !titulo) continue;

        // Fecha y hora propias de la zona; si no aparecen, "por determinar".
        const metaZona = extraerMetadatos(`${titulo}\n${texto}`, titulo);
        blocks.push({
          id: `z-${z.page}-${z.zona}`,
          page: z.page,
          zona: z.zona,
          titulo,
          fecha: metaZona.fecha || "por determinar",
          hora: metaZona.hora || "por determinar",
          text: texto,
          cropDataUrl: z.cropDataUrl,
        });
      }

      if (worker) await (worker as OcrWorker).terminate();
      setProgress(96);

      // 3) Extraer metadatos combinando texto nativo del PDF (más fiable)
      //    y, si no hubiera capa de texto, el resultado del OCR. El texto
      //    de páginas "foto + OCR incrustado" (paginasEscaneadas) se excluye
      //    aquí también: es el OCR de la app de escaneo, no texto nativo.
      const nativeFull = nativePageTexts
        .filter((p) => !paginasEscaneadas.has(p.page))
        .map((p) => p.text)
        .join("\n");
      const ocrFull = pagesText.map((p) => p.text).join("\n") + "\n" + headerTexts.join("\n");
      const meta = extraerMetadatos(`${nativeFull}\n${ocrFull}`, tituloDetectado);
      // Si no se detecta fecha, la dejamos "por determinar".
      // Si no se detecta hora pero sí fecha, usamos la hora actual;
      // si tampoco hay fecha, la hora queda "por determinar".
      if (!meta.fecha) {
        meta.fecha = "por determinar";
        if (!meta.hora) meta.hora = "por determinar";
      } else if (!meta.hora) {
        meta.hora = new Date().toTimeString().slice(0, 5);
      }
      setMetadata(meta);

      setProgress(100);
      setProgressLabel("Listo");
      setImages(foundImages);
      setTextBlocks(blocks);
      setSelectedImgIds(new Set(foundImages.map((i) => i.id)));
      setSelectedTextIds(new Set(blocks.map((b) => b.id)));

      if (foundImages.length === 0 && blocks.length === 0) {
        toast.warning("No se ha extraído contenido del PDF.");
      } else {
        toast.success("Datos extraídos. Revisa y ajusta si es necesario.");
      }
      setStage("select");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      toast.error(`Error procesando el PDF: ${msg}`);
      setStage("form");
    }
  }, [file, regions, rotations]);

  const toggleImg = (id: string) => {
    setSelectedImgIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const toggleTxt = (id: string) => {
    setSelectedTextIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const finalImages = useMemo(
    () => images.filter((i) => selectedImgIds.has(i.id)),
    [images, selectedImgIds],
  );
  const finalTexts = useMemo(
    () => textBlocks.filter((b) => selectedTextIds.has(b.id)),
    [textBlocks, selectedTextIds],
  );

  const canFinish =
    metadata.periodico.trim() && metadata.titulo.trim() && metadata.fecha && metadata.hora;

  // Construye el objeto persistente a partir del estado actual de edición.
  const buildSavedNoticia = (id: string, createdAt: number): SavedNoticia => ({
    id,
    createdAt,
    updatedAt: Date.now(),
    periodico: metadata.periodico,
    titulo: metadata.titulo,
    fecha: metadata.fecha,
    hora: metadata.hora,
    bloques: finalTexts.map((t) => {
      const pi = pageImages.find((p) => p.page === t.page);
      return {
        id: t.id,
        page: t.page,
        titulo: t.titulo ?? "",
        fecha: t.fecha ?? "",
        hora: t.hora ?? "",
        texto: t.text,
        imagenPagina: pi?.fullDataUrl ?? null,

        imagenSeleccion: t.cropDataUrl ?? pi?.cropDataUrl ?? null,
      };
    }),
    imagenes: finalImages.map((i) => ({
      id: i.id,
      dataUrl: i.dataUrl,
      ancho: i.width,
      alto: i.height,
    })),
  });

  const handleFinish = () => {
    if (!canFinish) {
      toast.error("Revisa periódico, título, fecha y hora antes de guardar.");
      return;
    }
    const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const noticia = buildSavedNoticia(id, Date.now());
    persist([noticia, ...saved]);
    setLastSavedId(id);
    setStage("done");
    toast.success("Noticia guardada en la biblioteca.");
  };

  const openLibrary = () => setStage("library");
  const deleteNoticia = (id: string) => {
    persist(saved.filter((n) => n.id !== id));
    if (editingId === id) setEditingId(null);
    toast.success("Noticia eliminada.");
  };
  const updateNoticia = (updated: SavedNoticia) => {
    persist(saved.map((n) => (n.id === updated.id ? { ...updated, updatedAt: Date.now() } : n)));
  };

  const handleExport = () => {
    const payload = {
      periodico: metadata.periodico,
      titulo: metadata.titulo,
      fecha: metadata.fecha,
      hora: metadata.hora,
      bloques: finalTexts.map((t) => {
        const pi = pageImages.find((p) => p.page === t.page);
        return {
          pagina: t.page,
          titulo: t.titulo ?? "",
          fecha: t.fecha ?? "",
          hora: t.hora ?? "",
          texto: t.text,
          // Imagen completa de la página de donde sale el bloque y, si el
          // usuario marcó una zona en esa página, el recorte de la selección.
          // Ambas van como data URL WebP para poder abrirlas por separado.
          imagenPagina: pi?.fullDataUrl ?? null,
          zona: t.zona ?? 1,
          imagenSeleccion: t.cropDataUrl ?? pi?.cropDataUrl ?? null,
        };
      }),
      imagenes: finalImages.map((i) => ({
        pagina: i.page,
        ancho: i.width,
        alto: i.height,
        dataUrl: i.dataUrl,
      })),
      paginas: pageImages.map((p) => ({
        pagina: p.page,
        imagenPagina: p.fullDataUrl,
        imagenSeleccion: p.cropDataUrl ?? null,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      `${metadata.periodico}-${metadata.titulo}`.replace(/[^\w\-]+/g, "_").slice(0, 80) + ".json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-6 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Newspaper className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-bold tracking-tight">SocidaPress</h1>
            <p className="text-xs text-muted-foreground">
              Importa noticias en PDF, extrae imágenes y texto por OCR
            </p>
          </div>
          <Button
            variant={stage === "library" ? "default" : "outline"}
            size="sm"
            onClick={openLibrary}
            className="gap-2"
          >
            <Library className="h-4 w-4" />
            Biblioteca
            {saved.length > 0 && (
              <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium">
                {saved.length}
              </span>
            )}
          </Button>
          {stage !== "form" && stage !== "library" && (
            <Button variant="ghost" size="sm" onClick={handleReset} className="gap-2">
              <RotateCcw className="h-4 w-4" />
              Nueva
            </Button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        {stage === "form" && (
          <Card>
            <CardHeader>
              <CardTitle>Nueva noticia</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="pdf">Archivo PDF de la noticia</Label>
                <Input
                  id="pdf"
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                {file && (
                  <p className="text-xs text-muted-foreground">
                    Seleccionado: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Sube el PDF y en el siguiente paso podrás marcar sobre cada página la zona exacta
                  que quieres escanear (opcional). Después SocidaPress detectará automáticamente el
                  periódico, el título, la fecha y la hora.
                </p>
              </div>

              <div className="flex justify-end">
                <Button onClick={loadPdfForRegion} disabled={!file} size="lg" className="gap-2">
                  <FileUp className="h-4 w-4" />
                  Continuar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {stage === "region" && (
          <Card>
            <CardHeader>
              <CardTitle>Marca la zona a escanear</CardTitle>
              <p className="text-sm text-muted-foreground">
                Arrastra con el ratón sobre cada página para marcar una o varias zonas. Se escaneará{" "}
                <b>sólo</b> lo que marques. Usa los botones de girar si la página aparece torcida.
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {thumbs.map((t) => (
                <RegionPicker
                  key={t.page}
                  thumb={t}
                  rects={regions[t.page] ?? []}
                  rotation={rotations[t.page] ?? t.pdfRotation}
                  onChange={(rects) =>
                    setRegions((prev) => {
                      const n = { ...prev };
                      if (rects.length) n[t.page] = rects;
                      else delete n[t.page];
                      return n;
                    })
                  }
                  onRotate={(rot) => setRotations((prev) => ({ ...prev, [t.page]: rot }))}
                />
              ))}
              <div className="flex justify-between">
                <Button variant="outline" onClick={handleReset} className="gap-2">
                  <RotateCcw className="h-4 w-4" /> Volver
                </Button>
                <Button onClick={processPdf} size="lg" className="gap-2">
                  <FileUp className="h-4 w-4" /> Procesar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {stage === "processing" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin" />
                Procesando…
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Progress value={progress} />
              <p className="text-sm text-muted-foreground">{progressLabel}</p>
              <p className="text-xs text-muted-foreground">
                El OCR puede tardar varios segundos por página.
              </p>
            </CardContent>
          </Card>
        )}

        {stage === "select" && (
          <div className="space-y-8">
            <Card>
              <CardHeader>
                <CardTitle>Datos de la noticia</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Extraídos automáticamente del PDF. Revísalos y edítalos si es necesario.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="periodico">Periódico</Label>
                    <Input
                      id="periodico"
                      value={metadata.periodico}
                      onChange={(e) => setMetadata({ ...metadata, periodico: e.target.value })}
                      placeholder="Ej. El País"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="titulo">Título de la noticia</Label>
                    <Input
                      id="titulo"
                      value={metadata.titulo}
                      onChange={(e) => setMetadata({ ...metadata, titulo: e.target.value })}
                      placeholder="Titular"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fecha">Fecha</Label>
                    <Input
                      id="fecha"
                      type={metadata.fecha === "por determinar" ? "text" : "date"}
                      value={metadata.fecha}
                      onChange={(e) => setMetadata({ ...metadata, fecha: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="hora">Hora</Label>
                    <Input
                      id="hora"
                      type={metadata.hora === "por determinar" ? "text" : "time"}
                      value={metadata.hora}
                      onChange={(e) => setMetadata({ ...metadata, hora: e.target.value })}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Separator />

            <Card>
              <CardHeader>
                <CardTitle>Imágenes detectadas ({images.length})</CardTitle>
              </CardHeader>
              <CardContent>
                {images.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No se han encontrado imágenes embebidas en el PDF.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                    {images.map((img) => {
                      const selected = selectedImgIds.has(img.id);
                      return (
                        <button
                          type="button"
                          key={img.id}
                          onClick={() => toggleImg(img.id)}
                          className={`group relative overflow-hidden rounded-lg border-2 transition ${
                            selected
                              ? "border-primary ring-2 ring-primary/30"
                              : "border-border opacity-70 hover:opacity-100"
                          }`}
                        >
                          <img
                            src={img.dataUrl}
                            alt={`Imagen página ${img.page}`}
                            loading="lazy"
                            className="h-40 w-full object-cover"
                          />
                          <div className="absolute left-2 top-2">
                            <Checkbox checked={selected} />
                          </div>
                          <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-2 py-1 text-left text-xs text-white">
                            Pág. {img.page} · {img.width}×{img.height}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Bloques de texto detectados ({textBlocks.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {textBlocks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No se ha extraído texto por OCR.</p>
                ) : (
                  textBlocks.map((b) => {
                    const selected = selectedTextIds.has(b.id);
                    return (
                      <label
                        key={b.id}
                        className={`flex cursor-pointer gap-3 rounded-lg border-2 p-3 transition ${
                          selected
                            ? "border-primary bg-primary/5"
                            : "border-border opacity-70 hover:opacity-100"
                        }`}
                      >
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleTxt(b.id)}
                          className="mt-1"
                        />
                        <div className="flex-1 space-y-2">
                          <p className="text-xs font-medium text-muted-foreground">
                            Página {b.page}
                            {b.zona ? ` · zona ${b.zona}` : ""}
                          </p>
                          {b.cropDataUrl && (
                            <a href={b.cropDataUrl} target="_blank" rel="noreferrer">
                              <img
                                src={b.cropDataUrl}
                                alt={`Zona ${b.zona} de la página ${b.page}`}
                                loading="lazy"
                                className="max-h-56 w-full rounded-md border object-contain"
                              />
                            </a>
                          )}

                          <Input
                            value={b.titulo ?? ""}
                            placeholder="Subtítulo del bloque (opcional)"
                            onChange={(e) => {
                              const v = e.target.value;
                              setTextBlocks((prev) =>
                                prev.map((x) => (x.id === b.id ? { ...x, titulo: v } : x)),
                              );
                            }}
                            className="font-semibold"
                          />
                          <div className="grid gap-2 sm:grid-cols-2">
                            <Input
                              type="text"
                              value={b.fecha ?? ""}
                              placeholder="Fecha (opcional)"
                              onChange={(e) => {
                                const v = e.target.value;
                                setTextBlocks((prev) =>
                                  prev.map((x) => (x.id === b.id ? { ...x, fecha: v } : x)),
                                );
                              }}
                            />
                            <Input
                              type="text"
                              value={b.hora ?? ""}
                              placeholder="Hora (opcional)"
                              onChange={(e) => {
                                const v = e.target.value;
                                setTextBlocks((prev) =>
                                  prev.map((x) => (x.id === b.id ? { ...x, hora: v } : x)),
                                );
                              }}
                            />
                          </div>

                          <Textarea
                            value={b.text}
                            onChange={(e) => {
                              const v = e.target.value;
                              setTextBlocks((prev) =>
                                prev.map((x) => (x.id === b.id ? { ...x, text: v } : x)),
                              );
                            }}
                            className="min-h-24 text-sm"
                          />
                        </div>
                      </label>
                    );
                  })
                )}
              </CardContent>
            </Card>

            <div className="flex justify-between">
              <Button variant="outline" onClick={handleReset} className="gap-2">
                <RotateCcw className="h-4 w-4" />
                Empezar de nuevo
              </Button>
              <Button onClick={handleFinish} size="lg" disabled={!canFinish}>
                Guardar noticia
              </Button>
            </div>
          </div>
        )}

        {stage === "done" && (
          <Card>
            <CardHeader>
              <CardTitle>{metadata.titulo}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {metadata.periodico} · {metadata.fecha} · {metadata.hora}
              </p>
            </CardHeader>
            <CardContent className="space-y-6">
              {finalImages.length > 0 && (
                <div>
                  <h3 className="mb-3 text-sm font-semibold">
                    Imágenes conservadas ({finalImages.length})
                  </h3>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                    {finalImages.map((img) => (
                      <img
                        key={img.id}
                        src={img.dataUrl}
                        alt=""
                        loading="lazy"
                        className="rounded-md border object-cover"
                      />
                    ))}
                  </div>
                </div>
              )}
              {finalTexts.length > 0 && (
                <div>
                  <h3 className="mb-3 text-sm font-semibold">
                    Bloques guardados ({finalTexts.length})
                  </h3>
                  <div className="space-y-6">
                    {finalTexts.map((t) => {
                      const pi = pageImages.find((p) => p.page === t.page);
                      return (
                        <div key={t.id} className="space-y-3 rounded-md border bg-muted/30 p-4">
                          <div className="space-y-1">
                            {t.titulo && <h4 className="text-base font-semibold">{t.titulo}</h4>}
                            <p className="text-xs text-muted-foreground">
                              Página {t.page} · {t.fecha || "fecha por determinar"} ·{" "}
                              {t.hora || "hora por determinar"}
                            </p>
                          </div>
                          {(pi?.fullDataUrl || pi?.cropDataUrl) && (
                            <div className="grid gap-3 md:grid-cols-2">
                              {pi?.fullDataUrl && (
                                <figure className="space-y-1">
                                  <a href={pi.fullDataUrl} target="_blank" rel="noreferrer">
                                    <img
                                      src={pi.fullDataUrl}
                                      alt={`Página ${t.page} completa`}
                                      loading="lazy"
                                      className="w-full rounded border"
                                    />
                                  </a>
                                  <figcaption className="text-xs text-muted-foreground">
                                    Página completa
                                  </figcaption>
                                </figure>
                              )}
                              {pi?.cropDataUrl && (
                                <figure className="space-y-1">
                                  <a href={pi.cropDataUrl} target="_blank" rel="noreferrer">
                                    <img
                                      src={pi.cropDataUrl}
                                      alt={`Selección de la página ${t.page}`}
                                      loading="lazy"
                                      className="w-full rounded border"
                                    />
                                  </a>
                                  <figcaption className="text-xs text-muted-foreground">
                                    Selección marcada
                                  </figcaption>
                                </figure>
                              )}
                            </div>
                          )}
                          <p className="whitespace-pre-wrap text-sm">{t.text}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex justify-between">
                <Button variant="outline" onClick={handleReset} className="gap-2">
                  <RotateCcw className="h-4 w-4" />
                  Nueva noticia
                </Button>
                <Button onClick={handleExport} className="gap-2">
                  <Download className="h-4 w-4" />
                  Descargar JSON
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {stage === "library" && (
          <LibraryView
            noticias={saved}
            editingId={editingId}
            highlightId={lastSavedId}
            onEdit={setEditingId}
            onDelete={deleteNoticia}
            onUpdate={updateNoticia}
            onNew={handleReset}
          />
        )}
      </main>
    </div>
  );
}
