/** Entirely fictional, generated in memory; no real resume or file fixture. */
export function fictionalResumePdf(pages:readonly string[]=['Fictional CV. Strategy course research.']){
 const font=3+pages.length*2,objects:string[]=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids ['+pages.map((_,i)=>(3+2*i)+' 0 R').join(' ')+'] /Count '+pages.length+' >>'];
 for(let i=0;i<pages.length;i++){
  const text=pages[i]!.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
  const stream='BT /F1 12 Tf 40 740 Td ('+text+') Tj ET';
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 '+font+' 0 R >> >> /Contents '+(4+2*i)+' 0 R >>','<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream');
 }
 objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
 let output='%PDF-1.7\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(output));output+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';}const xref=Buffer.byteLength(output);output+='xref\n0 '+offsets.length+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';return Buffer.from(output);
}
