// The datastore file browser that vCenter and ESXi both serve under /folder, as the HTML listing the providers read to find ISO images.
export function datastoreFolderResponse(isos, url) {
  const datastore = url.searchParams.get('dsName'), files = isos[datastore];
  if (!files) return new Response('not found', { status: 404 });
  const dir = decodeURIComponent(url.pathname.slice('/folder/'.length));
  const children = [...new Set(files.filter(f => f.startsWith(dir) && f !== dir).map(f => f.slice(dir.length).split('/')[0] + (f.slice(dir.length).includes('/') ? '/' : '')))];
  const links = children.map(name => `<a href="/folder/${dir}${name}?dcPath=ha-datacenter&amp;dsName=${datastore}">${name}</a>`).join('');
  return new Response(`<html><body>${links}<a href="#top">top</a><a href="https://elsewhere.example/folder/evil.iso">elsewhere</a></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
}
