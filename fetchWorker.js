onmessage = async function(event) {
  let {file, sampleRate} = event.data;
  postMessage({update: `Feetching ${file}...`});
  let url = `https://analysis-output.telemetry.mozilla.org/bhr/data/hang_aggregates/${file}`;
  let response = await fetch(url);
  postMessage({update: `Parsing ${file}...`});
  let data = await response.json();
  postMessage({update: `Processing ${file}...`});

  let thread;
  for (thread of data.threads)
    if (thread.name == "Gecko" && thread.processType == "default")
      break;
  let day = thread.dates[0];
  let date = day.date;
  postMessage({date});
  let usageHours = data.usageHoursByDate[date] / sampleRate;

  let hangs = [];
  let hangCount = day.sampleHangMs.length;
  for (let id = 0; id < hangCount; ++id) {
    let frames = [];
    let stack = thread.sampleTable.stack[id];
    let shouldRemovePrefix = true;

    while (stack) {
      let func = thread.stackTable.func[stack];
      let funcName = thread.stringArray[thread.funcTable.name[func]];
      // Stacks with nested event loops are confusing, stop walking the stack
      // as soon as we reach the event queue.
      if (funcName.startsWith("NS_ProcessNextEvent(nsIThread"))
        break;
      let libName = thread.libs[thread.funcTable.lib[func]].name;

      // Leave only one non-Mozilla frame at the top of the stack.
      if (shouldRemovePrefix &&
          ["xul", "XUL", "libxul.so", //"nss3", "libnss3.dylib",
           "mozglue", "libmozglue.so"].includes(libName) &&
          !funcName.includes("::InterposedNt")) {
        shouldRemovePrefix = false;
        if (frames.length > 1)
          //          frames.splice(0, frames.length - 1);
          for (let i = 0; i < frames.length - 1; ++i)
            frames[i].hidden = "Foreign code";
      }

      function isJSFuncName(n) {
        return n.includes(".js") || n.includes(".xul") || n.startsWith("self-hosted:");
      }
      if (!libName && isJSFuncName(funcName) && frames.length) {
        // We are on a JS frame, trim all the previous frames that are internal
        // to the JS engine.
        let i = frames.length - 1;
        const kJSInternalPrefixes = [
          "js::", "JS::",
          "static bool InternalCall",
          "static bool Interpret",
          "static bool js::",
          "bool js::",
          "static bool SetExistingProperty",
          "(unresolved)",
        ];
        while (i && kJSInternalPrefixes.some(p => frames[i].funcName.startsWith(p)))
          --i;
        if (frames[i]) {
          let f = frames[i];
          if ((!f.libName && isJSFuncName(f.funcName)) ||
              f.funcName.startsWith("static bool XPC_WN_"))
            //            frames.splice(i + 1);
            for (let ii = i + 1; ii < frames.length; ++ii)
              frames[ii].hidden = "JS Engine Internal";
        }

        if (frames.length > 3 &&
            ["XPTC__InvokebyIndex", "NS_InvokeByIndex"].includes(frames[frames.length - 3].funcName) &&
            frames[frames.length - 2].funcName.startsWith("XPCWrappedNative::CallMethod(") &&
            frames[frames.length - 1].funcName.startsWith("static bool XPC_WN_"))
          //          frames.splice(frames.length - 3);
          for (let ii = frames.length - 3; ii < frames.length; ++ii)
            frames[ii].hidden = "JS Engine Internal";
      }
      
      frames.push({funcName, libName, hidden: ""});
      stack = thread.stackTable.prefix[stack];
    }
    hangs.push({duration: Math.round(day.sampleHangMs[id] * usageHours),
                count: Math.round(day.sampleHangCount[id] * usageHours),
                frames});
  }
  postMessage({result: hangs});
}
