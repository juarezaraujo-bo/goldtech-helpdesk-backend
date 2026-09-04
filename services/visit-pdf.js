const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const labels = { com_demanda: 'Com demanda', sem_demanda: 'Sem demanda' };
const formatDate = value => value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(new Date(value.replace(' ', 'T') + 'Z')) : 'Não informado';
const duration = (start, end) => { if (!start || !end) return 'Não disponível'; const ms = new Date(end.replace(' ', 'T') + 'Z') - new Date(start.replace(' ', 'T') + 'Z'); const minutes = Math.max(0, Math.round(ms / 60000)); return Math.floor(minutes / 60) + 'h ' + String(minutes % 60).padStart(2, '0') + 'min'; };

function generateVisitPdf({ visit, departments, outputPath }) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = outputPath + '.tmp-' + process.pid + '-' + Date.now();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 44, bufferPages: true, info: { Title: 'Relatório de Visita Técnica - ' + visit.visit_number, Author: 'Goldtech Helpdesk' } });
    const stream = fs.createWriteStream(temporary);
    doc.pipe(stream);
    const left = 44, width = doc.page.width - 88, bottom = doc.page.height - 82;
    const ink = '#17283c', muted = '#627184', gold = '#b48a32';
    let y;
    function header() {
      doc.rect(0, 0, doc.page.width, 78).fill('#101f32');
      doc.rect(left, 32, 3, 31).fill(gold);
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#ffffff').text('GOLDTECH', left + 14, 29);
      doc.font('Helvetica').fontSize(8).fillColor('#d5bd83').text('SERVIÇOS E SOLUÇÕES EM TECNOLOGIA', left + 14, 55);
      doc.fontSize(8).fillColor('#ffffff').text('RELATÓRIO TÉCNICO', left + 310, 38, { width: width - 310, align: 'right' });
      y = 96;
    }
    function block(title, rows, accent = gold) {
      const heights = rows.map(row => Math.max(...row.map(([label, value, emphasis]) => {
        doc.font(emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(emphasis ? 11 : 10);
        return doc.heightOfString(String(value || 'Não informado'), { width: (width - 32) / row.length - 12, lineGap: 2 });
      })) + 22);
      const height = 34 + heights.reduce((sum, value) => sum + value, 0);
      if (height > bottom - 96) {
        // Very long content retains the existing lossless continuation layout.
        card(title, rows.flat(), accent);
        return;
      }
      space(height + 12);
      doc.roundedRect(left, y, width, height, 6).fill('#f4f6f8');
      doc.rect(left, y + 12, 3, 14).fill(accent);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(accent).text(title.toUpperCase(), left + 16, y + 13);
      let rowY = y + 34;
      rows.forEach((row, index) => {
        const cellWidth = (width - 32) / row.length;
        row.forEach(([label, value, emphasis], column) => {
          const x = left + 16 + column * cellWidth;
          doc.font('Helvetica').fontSize(8).fillColor(muted).text(label, x, rowY, { width: cellWidth - 12 });
          doc.font(emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(emphasis ? 11 : 10).fillColor(emphasis ? accent : ink).text(String(value || 'Não informado'), x, rowY + 13, { width: cellWidth - 12, lineGap: 2 });
        });
        rowY += heights[index];
        if (index < rows.length - 1) doc.moveTo(left + 16, rowY - 4).lineTo(left + width - 16, rowY - 4).lineWidth(.4).strokeColor('#dce2e8').stroke();
      });
      y += height + 14;
    }
    doc.on('pageAdded', header);
    header();
    function space(height) { if (y + height > bottom) doc.addPage(); }
    function heading(text, size = 18) {
      doc.font('Helvetica-Bold').fontSize(size);
      const height = doc.heightOfString(String(text), { width });
      space(height + 15);
      doc.fillColor(ink).text(String(text), left, y, { width });
      y += height + 15;
    }
    // Split long fields into measured chunks, retaining every character on continuation cards.
    function card(title, rows, accent = gold) {
      let continuation = false;
      for (const [label, raw] of rows) {
        let remaining = String(raw || 'Não informado');
        do {
          space(80);
          doc.font('Helvetica').fontSize(10);
          const capacity = bottom - y - 64;
          let count = remaining.length;
          if (doc.heightOfString(remaining, { width: width - 32, lineGap: 3 }) > capacity) {
            let low = 1, high = remaining.length;
            while (low < high) {
              const mid = Math.ceil((low + high) / 2);
              if (doc.heightOfString(remaining.slice(0, mid), { width: width - 32, lineGap: 3 }) <= capacity) low = mid;
              else high = mid - 1;
            }
            count = low;
            const boundary = remaining.lastIndexOf(' ', count);
            if (boundary > count / 2) count = boundary + 1;
          }
          const text = remaining.slice(0, count);
          const height = doc.heightOfString(text, { width: width - 32, lineGap: 3 }) + 54;
          doc.roundedRect(left, y, width, height, 6).fill('#f4f6f8');
          doc.rect(left, y + 13, 3, 18).fill(accent);
          doc.font('Helvetica-Bold').fontSize(8).fillColor(accent).text(title.toUpperCase() + (continuation ? ' / CONTINUAÇÃO' : ''), left + 16, y + 13, { width: width - 32 });
          doc.fontSize(9).fillColor(muted).text(label, left + 16, y + 27, { width: width - 32 });
          doc.font('Helvetica').fontSize(10).fillColor(ink).text(text, left + 16, y + 40, { width: width - 32, lineGap: 3 });
          y += height + 6;
          remaining = remaining.slice(count);
          continuation = !!remaining;
          if (remaining) doc.addPage();
        } while (remaining);
      }
    }
    heading('Relatório de Visita Técnica', 24);
    heading(visit.visit_number, 15);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#24765e').text('VALIDADO ELETRONICAMENTE', left, y);
    y += 28;
    block('Dados da visita', [
      [['Cliente', visit.company_name, true], ['Unidade', visit.unit_name || 'Sem unidade específica', true]],
      [['Técnico', visit.technician_name, true], ['Data', visit.started_at ? formatDate(visit.started_at).split(',')[0] : 'Não informado', true]],
      [['Início', formatDate(visit.started_at)], ['Término', formatDate(visit.finished_at)], ['Duração', duration(visit.started_at, visit.finished_at)]]
    ]);
    departments.forEach((item, index) => {
      space(240);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(muted).text('SETOR ' + String(index + 1).padStart(2, '0'), left, y);
      y += 15;
      heading(item.department_name, 17);
      const badge = labels[item.demand_status] || item.demand_status;
      doc.font('Helvetica-Bold').fontSize(9);
      const badgeWidth = doc.widthOfString(badge) + 20;
      doc.roundedRect(left, y - 5, badgeWidth, 20, 4).fill(item.demand_status === 'sem_demanda' ? '#e8f3ee' : '#f5efdf');
      doc.fillColor(item.demand_status === 'sem_demanda' ? '#24765e' : gold).text(badge, left + 10, y, { width: badgeWidth });
      y += 25;
      block('Atendimento do setor', [
        [['Atividades realizadas', item.activities || item.standardized_description || 'Nenhuma atividade registrada']],
        [['Observações', item.notes || 'Nenhuma']],
        [['Pendência', item.has_pending_issue ? 'Sim' : 'Não'], ['Necessidade de retorno', item.requires_return ? 'Sim' : 'Não']]
      ]);
      block('Validação eletrônica', [
        [['Validado por', item.validator_name_snapshot], ['Cargo', item.validator_job_title_snapshot]],
        [['E-mail', item.validator_email_snapshot], ['Data e hora', formatDate(item.validated_at)]],
        [['Protocolo', item.validation_protocol, true]]
      ], '#24765e');
    });
    const range = doc.bufferedPageRange();
    const generatedAt = formatDate(new Date().toISOString().slice(0, 19).replace('T', ' '));
    for (let page = 0; page < range.count; page++) {
      doc.switchToPage(page);
      // Footers live below the body margin; keep PDFKit from flowing them onto a new page.
      const bodyBottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const top = doc.page.height - 65;
      doc.moveTo(left, top).lineTo(left + width, top).strokeColor('#dce2e8').lineWidth(.5).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(muted).text('Integridade: SHA-256 registrado no sistema. Documento validado eletronicamente.', left, top + 9, { width });
      doc.text('Goldtech | Relatório de Visita Técnica | Versão 1 | Gerado em ' + generatedAt, left, top + 22, { width, lineBreak: false });
      doc.font('Helvetica-Bold').text((page + 1) + ' / ' + range.count, left, top + 22, { width, align: 'right', lineBreak: false });
      doc.page.margins.bottom = bodyBottomMargin;
    }
    doc.end();
    stream.on('finish', () => { fs.renameSync(temporary, outputPath); resolve(outputPath); });
    stream.on('error', error => { fs.rmSync(temporary, { force: true }); reject(error); });
    doc.on('error', reject);
  });
}
module.exports = { generateVisitPdf, duration, formatDate };
