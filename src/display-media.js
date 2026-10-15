// Grants only the current trusted capture selection. A delayed native source
// lookup cannot grant desktop or system audio to a later capture / navigation.
function createDisplayMediaHandler({getSelection, getSources, platform = process.platform}) {
  return async (request, callback) => {
    let grant = null;
    try {
      const selection = getSelection();
      if (selection && request.frame === selection.frame && request.videoRequested === true &&
          (!request.audioRequested || (selection.audioAllowed === true && platform === 'win32'))) {
        const sources = await getSources();
        const current = getSelection();
        if (current && current.id === selection.id && current.revision === selection.revision &&
            current.frame === selection.frame && current.audioAllowed === selection.audioAllowed) {
          const source = sources.find(item => item.id === selection.id);
          if (source) grant = request.audioRequested ? {video: source, audio: 'loopback'} : {video: source};
        }
      }
    } catch { /* Deny failed lookups, never substitute another desktop source. */ }
    callback(grant);
  };
}

module.exports = {createDisplayMediaHandler};
