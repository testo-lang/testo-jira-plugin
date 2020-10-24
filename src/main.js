
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process')

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

function testo_run(args) {
	return new Promise(function(resolve, reject) {
		let p = child_process.spawn('testo', args)
		let stdout = ''
		let stderr = ''
		p.stdout.on('data', data => stdout += data)
		p.stderr.on('data', data => stderr += data)
		p.on('exit', code => {
			if (code) {
				reject(stderr)
			} else {
				resolve(stdout)
			}
		})
		p.on('error', error => reject(error))
	})
}

const deleteFolderRecursive = function(folder) {
	if (fs.existsSync(folder)) {
		fs.readdirSync(folder).forEach((file, index) => {
			const curPath = path.join(folder, file);
			if (fs.lstatSync(curPath).isDirectory()) { // recurse
				deleteFolderRecursive(curPath);
			} else { // delete file
				fs.unlinkSync(curPath);
			}
		});
		fs.rmdirSync(folder);
	}
};

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
			let test_case_key = path.parse(file_to_run).name
			let report_test_folder = path.join(report_folder, test_case_key)

			deleteFolderRecursive(report_test_folder)

			let testo_args = []

			testo_args.push('run')
			testo_args.push(file_to_run)
			testo_args.push('--assume_yes')
			testo_args.push('--report_folder')
			testo_args.push(report_test_folder)
			testo_args.push('--report_logs')
			testo_args.push('--report_screenshots')

			if (argv.license) {
				testo_args.push('--license')
				testo_args.push(argv.license)
			}

			for (param of params) {
				testo_args.push('--param')
				testo_args.push(param.name)
				testo_args.push(param.value)
			}

			testo_args.push('--invalidate')
			testo_args.push('some_test_2')

			let output = await testo_run(testo_args)
			console.log(output)

			let jira_test_run_report = []

			let testo_report = JSON.parse(fs.readFileSync(report_test_folder + '/report.json'))

			console.log(testo_report)

			let current_index = 0

			jira_test_run_report.push({
				status: 'Pass',
				testCaseKey: test_case_key,
				executionTime: Math.abs(Date.parse(testo_report.stop_timestamp) - Date.parse(testo_report.start_timestamp)),
				executionDate: testo_report.start_timestamp,
				executedBy: argv.username,

				scriptResults: [
					{
						index: 0,
						status: 'Pass',
						comment: output
					}
				]
			})

			let post_reponse = await axios.post(jira_rest_endpoint + `testrun/${argv.cycle}/testresults/`, jira_test_run_report, {auth: credentials})

			console.log(post_reponse)
		}
	} catch (error) {
		console.error("ERROR")
		console.error(error)
	}
}


main()


async function tmp() {
const cycles = await axios.get(jira_rest_endpoint + `testrun/SAMPLE-C6/testresults`, {auth: credentials});
console.log (cycles.data)

}


//tmp()