const inquirer = require('inquirer');
const fuzzy = require('fuzzy');
const fs = require('fs');
const zlib = require('zlib');
inquirer.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'));

// Assemble a filename consisting of app name, dyno name, and time stamp
function getFilename(app, dyno) {
  const d = new Date();
  const mm = d.getMonth();
  const dd = d.getDate();
  const yyyy = d.getFullYear();
  const hr = d.getHours();
  const min = d.getMinutes();
  const sec = d.getSeconds();
  return `${app}_${dyno}_${mm}-${dd}-${yyyy}_${hr}-${min}-${sec}`;
}

// Run the exec alias java_heap_dump on a dyno
async function heapDump(appkit, args) {
  try {
    const dynos = await appkit.api.get(`/apps/${args.app}/dynos`);
    const dynoNames = dynos.map(ps => `${ps.type}.${ps.name}`);
    if (dynoNames.length <= 0) {
      throw new Error('The specified application does not have any dynos!');
    }

    // Make sure that the provided dyno is valid. If none was provided, prompt the user to select one.
    if (!args.dyno || args.dyno === '') {
      if (dynoNames.length === 1) {
        [args.dyno] = dynoNames;
      } else {
        const searchDynos = async input => fuzzy.filter((input || ''), dynoNames).map(e => e.original);

        const answers = await inquirer.prompt([
          {
            name: 'dyno',
            type: 'autocomplete',
            message: 'Select a Dyno:',
            source: (ans, input) => searchDynos(input),
          },
        ]);
        args.dyno = answers.dyno;
      }
    } else if (args.dyno && args.dyno !== '' && !dynoNames.find(name => name === args.dyno)) {
      throw new Error('Invalid dyno name');
    }
  } catch (err) {
    appkit.terminal.error(err);
    return;
  }

  const task = appkit.terminal.task(`Fetching heap dump from dyno ${args.dyno} on ${args.app}`);
  task.start();

  try {
    // Run the aliased command on the specified dyno
    const output = await appkit.api.post(JSON.stringify({ alias: 'java_heap_dump' }), `/apps/${args.app}/dynos/${args.dyno}/actions/attach`);

    if (output.stderr) {
      throw new Error(output.stderr);
    }

    // If no stdout, this means there was an issue running the jcmd command.
    if (output.stdout === '') {
      throw new Error('Unspecified error running command. Please make sure that a Java process is running on the selected dyno.');
    }

    // The base64 string of a heap dump will be way larger than 5000 characters.
    // This is almost certainly an error message (error output from jcmd)
    if (output.stdout.length < 5000) {
      throw new Error(output.stdout);
    }

    let filename;
    if (args.filename) {
      filename = `${process.cwd()}/${args.filename}`;
    } else {
      filename = `${process.cwd()}/${getFilename(args.app, args.dyno)}.hprof`;
    }

    const gzipBuffer = Buffer.from(output.stdout, 'base64');
    const buf = zlib.gunzipSync(gzipBuffer);
    fs.writeFileSync(filename, buf);

    task.end('ok');
    console.log(`Heap dump successfully saved as ${filename}`);
  } catch (err) {
    task.end('error');
    appkit.terminal.error(err);
  }
}


function update() {}

function init(appkit) {
  const heapdumpBuilder = (args) => {
    args.option('dyno', {
      description: 'Dyno ID', type: 'string', alias: 'd', demand: false,
    });
    args.option('app', {
      description: 'App name', type: 'string', alias: 'a', demand: true,
    });
    args.option('filename', {
      description: 'Filename for heap dump', type: 'string', alias: 'o', demand: false,
    });
  };

  appkit.args
    .command('java:heapdump [dyno] [filename]', 'Get Java heap dump from a dyno', heapdumpBuilder, heapDump.bind(null, appkit));
}

module.exports = {
  init,
  update,
  group: 'java',
  help: 'Java tools for Akkeris apps',
  primary: true,
};
