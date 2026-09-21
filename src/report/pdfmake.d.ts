// pdfmake.d.ts — локальное объявление серверной точки входа pdfmake 0.3.11
// (В4.7, Б4). Типов в пакете нет, `@types/*` по закону вехи не ставим —
// описан ровно тот срез API, которым пользуется `pdf.ts`.
declare module "pdfmake" {
  interface PdfOutputDocument {
    getBuffer(): Promise<Buffer>;
  }
  interface PdfMakeServer {
    setFonts(fonts: Record<string, { normal: string; bold: string; italics: string; bolditalics: string }>): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    createPdf(docDefinition: object, options?: object): PdfOutputDocument;
  }
  const pdfmake: PdfMakeServer;
  export default pdfmake;
}
