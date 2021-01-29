#!/usr/bin/node

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process')
const FormData = require('form-data');

let argv = require('yargs/yargs')(process.argv.slice(2))
	.usage('Usage: $0 [options]')
	.demandOption(['jira_url', 'username', 'password', 'cycle', 'testo_project_dir'])
	.describe('jira_url', 'target JIRA url (e.g. http://www.my_host.ru/jira')
	.describe('username', 'JIRA login')
	.describe('password', 'JIRA password')
	.describe('cycle', 'TJ4M cycle to run by Testo')
	.describe('testo_project_dir', 'path to the dir with Testo tests')
	.describe('submit_result', 'Do not run testo. Just submit existing report for specified test case')
	.describe('param', 'param to pass into Testo script')
	.describe('license', 'license file to pass into Testo')
	.describe('prefix', 'prefix to pass into Testo')
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

if (argv.jira_url[argv.jira_url.length - 1] == "/") argv.jira_url = argv.jira_url.substr(0, argv.jira_url.length - 1)
let jira_rest_endpoint = argv.jira_url + "/rest/atm/1.0/"


async function walk(dir, basenames_to_match, ext) {
	let files = await fs.promises.readdir(dir)
	let result = []
	for (let file of files) {
		let file_path = path.join(dir, file)
		let stat = await fs.promises.stat(file_path)
		if (stat.isDirectory()) {
			result = result.concat(await walk(file_path, basenames_to_match, ext))
		} else {
			for (basename of basenames_to_match) {
				if (path.basename(file_path) == basename + ext) {
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
			if (code > 1) {
				reject(stderr)
			} else {
				resolve(stdout)
			}
		})
		p.on('error', error => reject(error))
	})
}

function deleteFolderRecursive(folder) {
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

function Sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function SuperAxios(args) {
	let interval = 10
	let n_times = 60
	for (let i = 0; i < n_times; ++i) {
		try {
			return await axios(args)
		} catch (error) {
			if (!error.response || (error.response.status != 404)) {
				throw error
			}
			process.stdout.write(`Failed to ${args.method} url ${args.url}. ${error}. `)
			if (i != (n_times - 1)) {
				process.stdout.write(`I'll try again in ${interval} seconds.\n`)
				await Sleep(interval * 1000)
			}
		}
	}
	process.stdout.write('Giving up.\n')
	throw "Exceeded the number of attempts to execute an http request"
}

// ========================== JIRA real functions ========================

async function GetCycleItems() {
	const response = await SuperAxios({
		method: 'get',
		url: jira_rest_endpoint + `testrun/${argv.cycle}`,
		auth: credentials
	});
	return response.data.items
}

async function SubmitTest(test) {
	let response = await SuperAxios({
		method: 'post',
		url: jira_rest_endpoint + `testrun/${argv.cycle}/testresults/`,
		data: test.report,
		auth: credentials
	})
	return response.data[0].id
}

async function AttachStuff(exec_id, attachment) {
	let response = await SuperAxios({
		method: 'post',
		url: jira_rest_endpoint + `testresult/${exec_id}/attachments`,
		data: attachment,
		auth: credentials,
		headers: attachment.getHeaders()
	})
}

// ==========================================================================

// ========================== JIRA mock functions ========================

// async function GetCycleItems() {
// 	return [
// 		{
// 			testCaseKey: "centos_backend_qemu_clean"
// 		},
// 		{
// 			testCaseKey: "centos_backend_qemu_flash"
// 		},
// 		{
// 			testCaseKey: "centos_backend_qemu_hostdev"
// 		},
// 		{
// 			testCaseKey: "centos_backend_qemu_test_spec_exclude"
// 		},
// 		{
// 			testCaseKey: "win10_ga"
// 		},
// 		{
// 			testCaseKey: "win7_ga"
// 		}
// 	]
// }
//
// async function SubmitTest(test) {
// 	console.log(test)
// 	return "EXEC_ID_" + test.test_case_key
// }
//
// async function AttachStuff(exec_id, attachment) {
// }

// ==========================================================================

function IsString(x) {
	return typeof x === 'string' || x instanceof String
}

async function main() {
	try {
		console.log(`Getting cycle ${argv.cycle} info from Jira...`);
		const cycle_items = await GetCycleItems()
		console.log('Success\n');

		let tests_to_run = []
		console.log("We're about to run the following test cases:")
		for (let item of cycle_items) {
			tests_to_run.push(item.testCaseKey)
			console.log(`\t- ${item.testCaseKey}`)
		}

		let files_to_run = await walk(argv.testo_project_dir, tests_to_run, '.testo')

		console.log('\nFound the following matching .testo files:')

		for (let file of files_to_run) {
			console.log(`\t-${file}`)
		}

		console.log('')

		if (files_to_run.length != tests_to_run.length) {
			let missing_tests = ""

			for (let test of tests_to_run) {
				found = false
				for (let file of files_to_run) {
					if (path.basename(file) == test + ".testo") {
						found = true
						break
					}
				}
				if (!found) {
					missing_tests += "\t- " + test + "\n"
				}
			}

			throw "Missing .testo files for the following tests:\n" + missing_tests
		}

		let tm4j_report = []

		for (let i = 0; i < files_to_run.length; i++) {
			let file_to_run = files_to_run[i]
			let test_case_key = path.parse(file_to_run).name
			let report_test_folder = path.join(report_folder, test_case_key)

			if (!argv.submit_result) {
				deleteFolderRecursive(report_test_folder)

				let testo_args = []

				testo_args.push('run')
				testo_args.push(file_to_run)
				testo_args.push('--assume_yes')
				testo_args.push('--report_folder')
				testo_args.push(report_test_folder)
				testo_args.push('--report_logs')
				testo_args.push('--report_screenshots')

				if (argv.prefix) {
					testo_args.push('--prefix')
					testo_args.push(argv.prefix)
				}

				if (argv.license) {
					testo_args.push('--license')
					testo_args.push(argv.license)
				}

				if (argv.param) {
					for (let i = 0; i < argv.param.length; i++) {
						testo_args.push('--param')
						testo_args.push(argv.param[i])
						testo_args.push(argv.param[++i])
					}
				}

				let testo_run_command = 'testo'

				for (let arg of testo_args) {
					testo_run_command += ' ' + arg
				}

				console.log(`Running test ${i+1}/${files_to_run.length}: ` + testo_run_command)
				await testo_run(testo_args)
				console.log('Success\n')
			}

			let testo_report = JSON.parse(fs.readFileSync(report_test_folder + '/report.json', 'utf8'))
			let output = ""

			let scriptResults = []
			let general_status = 'Pass'
			let testo_tests = []

			for (let i = 0; i < testo_report.tests.length; i++) {
				let test = testo_report.tests[i]
				testo_tests.push(test.name)
				let status = test.status == 'success' ? 'Pass' : 'Fail'

				if (!test.is_cached) {
					output += fs.readFileSync(report_test_folder + '/' + test.name, 'utf8')
				}

				if (status == 'Fail') {
					general_status = 'Fail'
					break;
				}
			}

			output += fs.readFileSync(report_test_folder + '/summary.txt', 'utf8')
			let message = output.replace(/\n/g, "<br>")

			scriptResults.push({
				index: 0,
				status: general_status,
				comment: message
			})

			let tm4j_test_run_report = [
				{
					status: general_status,
					testCaseKey: test_case_key,
					executionTime: Math.abs(Date.parse(testo_report.stop_timestamp) - Date.parse(testo_report.start_timestamp)),
					executionDate: testo_report.start_timestamp,
					executedBy: argv.username,
					scriptResults: scriptResults
				}
			]

			tm4j_report.push({
				test_case_key: test_case_key,
				report: tm4j_test_run_report,
				output: output,
				report_test_folder: report_test_folder,
				testo_tests: testo_tests
			})
		}

		console.log('Submitting results to Jira...')

		let submitted_tests_count = 0

		for (let test of tm4j_report) {
			let should_submit = true;
			if (argv.submit_result) {
				if (IsString(argv.submit_result)) {
					if (argv.submit_result != test.test_case_key) {
						should_submit = false;
					}
				}
			}

			if (should_submit) {
				let exec_id = await SubmitTest(test)
				console.log('Created Jira test result with id ' + exec_id)

				let attachment = new FormData();
				attachment.append('file', Buffer.from(test.output), {
					filename: 'summary_output.txt',
					contentType: 'text/html; charset=utf-8',
					knownLength: Buffer.from(test.output).length
				 });

				await AttachStuff(exec_id, attachment)
				console.log('Attached summary output file to the test result ' + exec_id)

				wait_error_files = await walk(test.report_test_folder, test.testo_tests, "_wait_failed.png")

				for (let file of wait_error_files) {
					attachment = new FormData();
					attachment.append('file', fs.createReadStream(file))
					await AttachStuff(exec_id, attachment)
					console.log(`Attached screenshot ${file} to the test result ${exec_id}`)
				}

				++submitted_tests_count
			}
		}

		if (!submitted_tests_count) {
			if (argv.submit_result) {
				if (IsString(argv.submit_result)) {
					throw `Couldn't find test results for test "${argv.submit_result}"`
				} else {
					throw `Couldn't find any test results`
				}
			}
		}

		console.log('All Done!')

	} catch (error) {
		console.error("\nERROR: " + error)
	}
}

main()
