
const axios = require('axios');
const fs = require('fs');
const path = require('path');

let argv = require('yargs/yargs')(process.argv.slice(2))
	.usage('Usage: $0 [options]')
	.demandOption(['jira_url', 'username', 'password', 'project', 'cycle', 'testo_project_dir'])
	.describe('jira_url', 'target JIRA url (e.g. http://www.my_host.ru/jira')
	.describe('username', 'JIRA login')
	.describe('password', 'JIRA password')
	.describe('project', 'JIRA project name')
	.describe('cycle', 'TJ4M cycle to run by Testo')
	.describe('testo_project_dir', 'path to the dir with Testo tests')
	.describe('param', 'param to pass into Testo script')
	.describe('license', 'license file to pass into Testo')
	.nargs('param', 2)
	.argv;


let credentials = {
	username: argv.username,
	password: argv.password
}

let report_folder = '/tmp/testo_tm4j_report_folder'

if (!fs.existsSync(report_folder)){
	fs.mkdirSync(report_folder);
}

console.log(argv.param)

let params = []

for (let i = 0; i < argv.param.length; i++) {
	params.push ({
		name: argv.param[i],
		value: argv.param[++i]
	})
}

let jira_rest_endpoint = argv.jira_url + "/rest/atm/1.0/"

async function walk(dir, basenames_to_match) {
	let files = await fs.promises.readdir(dir)
	let result = []
	for (let file of files) {
		let file_path = path.join(dir, file)
		let stat = await fs.promises.stat(file_path)
		if (stat.isDirectory()) {
			result = result.concat(await walk(file_path, basename_to_match))
		} else {
			for (basename of basenames_to_match) {
				if (path.basename(file_path) == basename + '.testo') {
					result.push(file_path)
				}
			}
		}
	}

	return result
}

async function main() {
	try {

		const cycles = await axios.get(jira_rest_endpoint + `testrun/search?query=projectKey = "${argv.project}"`, {auth: credentials});

		let tests_to_run = []

		for (let cycle of cycles.data) {
			if (cycle.key == argv.cycle) {
				for (let item of cycle.items) {
					tests_to_run.push(item.testCaseKey)
				}
				break;
			}
		}

		console.log(tests_to_run)

		let files_to_run = await walk(argv.testo_project_dir, tests_to_run)

		console.log(files_to_run)

		for (file_to_run of files_to_run) {
			let report_test_folder = report_folder + '/' + path.basename(file_to_run).name
			let testo_run_command = 'testo run ' + file_to_run
				+ ' --assume_yes'
				+ ' --report_folder ' + report_test_folder
				+ ' --report_logs'
				+ ' --report_screenshots'

			for (param of params) {
				testo_run_command += ` --param ${param.name} ${param.value}`
			}
			console.log(testo_run_command)
		}


	} catch (error) {
		console.error("ERROR")
		console.error(error)
	}
}


main()

