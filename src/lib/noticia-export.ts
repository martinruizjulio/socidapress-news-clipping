// Exportación de una noticia guardada (y sus bloques) a distintos
// formatos de archivo: TXT, CSV, Excel, PDF y Word. Todo se genera en el
// navegador (sin backend) y se descarga directamente.
import type { SavedBlock, SavedNoticia } from "@/components/socida-press";

// Nombre de archivo seguro a partir del periódico y el título de la
// noticia (o del primer bloque, si la noticia no tiene título propio).
function nombreArchivo(noticia: SavedNoticia, extension: string): string {
  const base = `${noticia.periodico || "noticia"}-${noticia.titulo || noticia.bloques[0]?.titulo || "sin_titulo"}`;
  const seguro = base.replace(/[^\w\-]+/g, "_").slice(0, 80) || "noticia";
  return `${seguro}.${extension}`;
}

// Nombre de archivo para la exportación conjunta de varias noticias a la
// vez (selección múltiple en la biblioteca): no tiene sentido basarlo en
// el título de una sola, así que usa la cantidad y la fecha de hoy.
function nombreArchivoVarias(cantidad: number, extension: string): string {
  const fecha = new Date().toISOString().slice(0, 10);
  return `noticias_${cantidad}_${fecha}.${extension}`;
}

function descargarBlob(blob: Blob, nombre: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}

// Cabecera común (periódico / fecha / hora / página) que antecede al
// texto de cada bloque, igual en TXT, PDF y Word para que los tres
// formatos de lectura muestren la misma información.
function cabeceraBloque(b: SavedBlock): string[] {
  const partes: string[] = [];
  if (b.periodico) partes.push(`Periódico: ${b.periodico}`);
  if (b.fecha) partes.push(`Fecha: ${b.fecha}`);
  if (b.hora) partes.push(`Hora: ${b.hora}`);
  partes.push(`Página: ${b.page}`);
  return partes;
}

// --- TXT --------------------------------------------------------------

export function exportarTxt(noticia: SavedNoticia) {
  const secciones = noticia.bloques.map((b) => {
    const lineas = [b.titulo || "(sin título)", ...cabeceraBloque(b), "", b.texto];
    return lineas.join("\n");
  });
  const contenido = secciones.join("\n\n" + "-".repeat(40) + "\n\n");
  descargarBlob(new Blob([contenido], { type: "text/plain;charset=utf-8" }), nombreArchivo(noticia, "txt"));
}

// --- CSV ----------------------------------------------------------------

function celdaCsv(v: string | number): string {
  const s = String(v ?? "");
  // Escapamos comillas dobles y envolvemos en comillas si hace falta
  // (coma, comillas o salto de línea), como exige el formato CSV.
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function exportarCsv(noticia: SavedNoticia) {
  const cabecera = ["Periodico", "Titulo", "Fecha", "Hora", "Pagina", "Texto"];
  const filas = noticia.bloques.map((b) =>
    [b.periodico || noticia.periodico, b.titulo, b.fecha, b.hora, b.page, b.texto].map(celdaCsv).join(","),
  );
  // BOM UTF-8 al principio para que Excel abra los acentos bien sin
  // configurar la codificación manualmente.
  const contenido = "﻿" + [cabecera.join(","), ...filas].join("\r\n");
  descargarBlob(new Blob([contenido], { type: "text/csv;charset=utf-8" }), nombreArchivo(noticia, "csv"));
}

// --- Excel (.xlsx) ------------------------------------------------------

export async function exportarExcel(noticia: SavedNoticia) {
  const XLSX = await import("xlsx");
  const filas = noticia.bloques.map((b) => ({
    Periodico: b.periodico || noticia.periodico,
    Titulo: b.titulo,
    Fecha: b.fecha,
    Hora: b.hora,
    Pagina: b.page,
    Texto: b.texto,
  }));
  const hoja = XLSX.utils.json_to_sheet(filas);
  // Columnas más anchas para que el texto largo no quede ilegible por
  // defecto; el resto se deja al ancho automático de SheetJS.
  hoja["!cols"] = [{ wch: 18 }, { wch: 30 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 80 }];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Noticia");
  XLSX.writeFile(libro, nombreArchivo(noticia, "xlsx"));
}

// --- PDF ------------------------------------------------------------------

export async function exportarPdf(noticia: SavedNoticia) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margen = 48;
  const anchoUtil = doc.internal.pageSize.getWidth() - margen * 2;
  const altoPagina = doc.internal.pageSize.getHeight();
  let y = margen;

  const nuevaLineaSiHaceFalta = (alto: number) => {
    if (y + alto > altoPagina - margen) {
      doc.addPage();
      y = margen;
    }
  };

  noticia.bloques.forEach((b, idx) => {
    if (idx > 0) {
      doc.addPage();
      y = margen;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    const tituloLineas = doc.splitTextToSize(b.titulo || "(sin título)", anchoUtil);
    nuevaLineaSiHaceFalta(tituloLineas.length * 20);
    doc.text(tituloLineas, margen, y);
    y += tituloLineas.length * 20 + 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(90);
    const meta = cabeceraBloque(b).join("   ·   ");
    nuevaLineaSiHaceFalta(16);
    doc.text(meta, margen, y);
    y += 22;
    doc.setTextColor(0);

    doc.setFontSize(11);
    const cuerpo = doc.splitTextToSize(b.texto || "(sin texto)", anchoUtil);
    for (const linea of cuerpo) {
      nuevaLineaSiHaceFalta(15);
      doc.text(linea, margen, y);
      y += 15;
    }
  });

  doc.save(nombreArchivo(noticia, "pdf"));
}

// --- Word (.docx) -----------------------------------------------------

export async function exportarWord(noticia: SavedNoticia) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");

  const secciones = noticia.bloques.map((b) => ({
    properties: {},
    children: [
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun(b.titulo || "(sin título)")],
      }),
      new Paragraph({
        children: [new TextRun({ text: cabeceraBloque(b).join("   ·   "), italics: true, color: "666666" })],
        spacing: { after: 200 },
      }),
      // Un párrafo por línea/salto de línea del texto original, para
      // conservar los saltos de párrafo que el usuario ya editó.
      ...(b.texto || "(sin texto)")
        .split(/\n+/)
        .filter((l) => l.length > 0)
        .map((linea) => new Paragraph({ children: [new TextRun(linea)], spacing: { after: 160 } })),
    ],
  }));

  const doc = new Document({ sections: secciones });
  const blob = await Packer.toBlob(doc);
  descargarBlob(blob, nombreArchivo(noticia, "docx"));
}

export type FormatoExportacion = "txt" | "csv" | "xlsx" | "pdf" | "docx";

export async function exportarNoticia(noticia: SavedNoticia, formato: FormatoExportacion) {
  switch (formato) {
    case "txt":
      return exportarTxt(noticia);
    case "csv":
      return exportarCsv(noticia);
    case "xlsx":
      return exportarExcel(noticia);
    case "pdf":
      return exportarPdf(noticia);
    case "docx":
      return exportarWord(noticia);
  }
}

// --- Exportación conjunta de varias noticias (selección múltiple) -------
//
// Mismo contenido que las funciones de arriba, pero juntando los bloques
// de todas las noticias elegidas en un solo archivo (una sola hoja Excel,
// un solo CSV, un solo PDF/Word con todos los bloques seguidos) en vez de
// descargar un archivo por noticia.

export function exportarTxtVarias(noticias: SavedNoticia[]) {
  const secciones = noticias.map((n) =>
    n.bloques
      .map((b) => [b.titulo || "(sin título)", ...cabeceraBloque(b), "", b.texto].join("\n"))
      .join("\n\n" + "-".repeat(40) + "\n\n"),
  );
  const contenido = secciones.join("\n\n" + "=".repeat(40) + "\n\n");
  descargarBlob(
    new Blob([contenido], { type: "text/plain;charset=utf-8" }),
    nombreArchivoVarias(noticias.length, "txt"),
  );
}

export function exportarCsvVarias(noticias: SavedNoticia[]) {
  const cabecera = ["Periodico", "Titulo", "Fecha", "Hora", "Pagina", "Texto"];
  const filas = noticias.flatMap((n) =>
    n.bloques.map((b) =>
      [b.periodico || n.periodico, b.titulo, b.fecha, b.hora, b.page, b.texto].map(celdaCsv).join(","),
    ),
  );
  const contenido = "﻿" + [cabecera.join(","), ...filas].join("\r\n");
  descargarBlob(
    new Blob([contenido], { type: "text/csv;charset=utf-8" }),
    nombreArchivoVarias(noticias.length, "csv"),
  );
}

export async function exportarExcelVarias(noticias: SavedNoticia[]) {
  const XLSX = await import("xlsx");
  const filas = noticias.flatMap((n) =>
    n.bloques.map((b) => ({
      Periodico: b.periodico || n.periodico,
      Titulo: b.titulo,
      Fecha: b.fecha,
      Hora: b.hora,
      Pagina: b.page,
      Texto: b.texto,
    })),
  );
  const hoja = XLSX.utils.json_to_sheet(filas);
  hoja["!cols"] = [{ wch: 18 }, { wch: 30 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 80 }];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Noticias");
  XLSX.writeFile(libro, nombreArchivoVarias(noticias.length, "xlsx"));
}

export async function exportarPdfVarias(noticias: SavedNoticia[]) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const margen = 48;
  const anchoUtil = doc.internal.pageSize.getWidth() - margen * 2;
  const altoPagina = doc.internal.pageSize.getHeight();
  let y = margen;
  let primerBloque = true;

  const nuevaLineaSiHaceFalta = (alto: number) => {
    if (y + alto > altoPagina - margen) {
      doc.addPage();
      y = margen;
    }
  };

  for (const n of noticias) {
    for (const b of n.bloques) {
      if (!primerBloque) {
        doc.addPage();
        y = margen;
      }
      primerBloque = false;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      const tituloLineas = doc.splitTextToSize(b.titulo || "(sin título)", anchoUtil);
      nuevaLineaSiHaceFalta(tituloLineas.length * 20);
      doc.text(tituloLineas, margen, y);
      y += tituloLineas.length * 20 + 6;

      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(90);
      const meta = cabeceraBloque(b).join("   ·   ");
      nuevaLineaSiHaceFalta(16);
      doc.text(meta, margen, y);
      y += 22;
      doc.setTextColor(0);

      doc.setFontSize(11);
      const cuerpo = doc.splitTextToSize(b.texto || "(sin texto)", anchoUtil);
      for (const linea of cuerpo) {
        nuevaLineaSiHaceFalta(15);
        doc.text(linea, margen, y);
        y += 15;
      }
    }
  }

  doc.save(nombreArchivoVarias(noticias.length, "pdf"));
}

export async function exportarWordVarias(noticias: SavedNoticia[]) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");

  const secciones = noticias
    .flatMap((n) => n.bloques)
    .map((b) => ({
      properties: {},
      children: [
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          children: [new TextRun(b.titulo || "(sin título)")],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: cabeceraBloque(b).join("   ·   "), italics: true, color: "666666" }),
          ],
          spacing: { after: 200 },
        }),
        ...(b.texto || "(sin texto)")
          .split(/\n+/)
          .filter((l) => l.length > 0)
          .map((linea) => new Paragraph({ children: [new TextRun(linea)], spacing: { after: 160 } })),
      ],
    }));

  const doc = new Document({ sections: secciones });
  const blob = await Packer.toBlob(doc);
  descargarBlob(blob, nombreArchivoVarias(noticias.length, "docx"));
}

export async function exportarVarias(noticias: SavedNoticia[], formato: FormatoExportacion) {
  switch (formato) {
    case "txt":
      return exportarTxtVarias(noticias);
    case "csv":
      return exportarCsvVarias(noticias);
    case "xlsx":
      return exportarExcelVarias(noticias);
    case "pdf":
      return exportarPdfVarias(noticias);
    case "docx":
      return exportarWordVarias(noticias);
  }
}
