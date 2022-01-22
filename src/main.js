#!/usr/bin/node

const fs = require('fs');
const path = require('path')
const FormData = require('form-data')
const crypto = require("crypto")
const {Walk, RunProcess, SuperAxios, LoadReport} = require('./utils')

let argv = require('yargs/yargs')(process.argv.slice(2))
	.usage('Usage: $0 [options]')
	.demandOption(['jira_url', 'username', 'password', 'cycle', 'testo_project_dir'])
	.describe('jira_url', 'target JIRA url (e.g. http://www.my_host.ru/jira)')
	.describe('username', 'JIRA login')
	.describe('password', 'JIRA password')
	.describe('cycle', 'TJ4M cycle to run by Testo')
	.describe('testo_project_dir', 'path to the dir with Testo tests')
	.describe('param', 'param to pass into Testo')
	.describe('nn_server', 'NN Server endpoint to pass into Testo')
	.describe('prefix', 'prefix to pass into Testo')
	.describe('invalidate', 'invalidate tests that correspond to a specified wildcard pattern')
	.describe('report_folder', 'path where to save the report')
	.default('report_folder', function tmpDir() {
		return "/tmp/testo_tm4j_report_folder_" + crypto.randomBytes(5).toString('hex')
	})
	.nargs('jira_url', 1)
	.nargs('username', 1)
	.nargs('password', 1)
	.nargs('cycle', 1)
	.nargs('testo_project_dir', 1)
	.nargs('param', 2)
	.nargs('nn_server', 1)
	.nargs('prefix', 1)
	.nargs('invalidate', 1)
	.nargs('report_folder', 1)
	.argv;

let credentials = {
	username: argv.username,
	password: argv.password
}

if (argv.jira_url[argv.jira_url.length - 1] == "/") {
	argv.jira_url = argv.jira_url.substr(0, argv.jira_url.length - 1)
}

let jira_rest_endpoint = argv.jira_url + "/rest/atm/1.0/"

if (fs.existsSync(argv.testo_project_dir)) {
	let stat = fs.statSync(argv.testo_project_dir)
	if (!stat.isDirectory()) {
		console.log(`Path "${argv.testo_project_dir}" is not a directory`)
		process.exit(1)
	}
} else {
	console.log(`Path "${argv.testo_project_dir}" does not exists`)
	process.exit(1)
}

if (fs.existsSync(argv.report_folder)) {
	let stat = fs.statSync(argv.report_folder)
	if (!stat.isDirectory()) {
		console.log(`Path "${argv.report_folder}" is not a directory`)
		process.exit(1)
	}
	let files = fs.readdirSync(argv.report_folder)
	if (!files.includes(".testo_report_folder") && files.length) {
		console.log(`Directory "${argv.report_folder}" is not a testo report folder`)
		process.exit(1)
	}
} else {
	fs.mkdirSync(argv.report_folder, {recursive: true})
}

fs.closeSync(fs.openSync(path.join(argv.report_folder, '.testo_report_folder'), 'w'))

// ========================== JIRA API ========================

async function GetCycleItems() {
	const response = await SuperAxios({
		method: 'get',
		url: jira_rest_endpoint + `testrun/${argv.cycle}`,
		auth: credentials
	});
	return response.data.items
}

async function SubmitTest(report) {
	let response = await SuperAxios({
		method: 'post',
		url: jira_rest_endpoint + `testrun/${argv.cycle}/testresults/`,
		data: report,
		auth: credentials
	})
	return response.data[0].id
}

async function UpdateTest(report) {
	let response = await SuperAxios({
		method: 'put',
		url: jira_rest_endpoint + `testrun/${argv.cycle}/testcase/${report.testCaseKey}/testresult`,
		data: report,
		auth: credentials
	})
	return response.data.id
}


async function GetTestRuns() {
	let response = await SuperAxios({
		method: 'get',
		url: jira_rest_endpoint + `testrun/${argv.cycle}/testresults/`,
		auth: credentials
	})
	return response.data
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

async function main() {
	let package_json_path = path.join(__dirname, '..', 'package.json')
	let package_json = JSON.parse(fs.readFileSync(package_json_path, 'utf8'))

	try {
		console.log(`Getting cycle ${argv.cycle} info from Jira...`);
		const cycle_items = await GetCycleItems()

		console.log('')

		let tests_to_run = []
		console.log("Found the following test cases:")
		for (let item of cycle_items) {
			tests_to_run.push(item.testCaseKey)
			console.log(`\t- ${item.testCaseKey}`)
		}

		let files_to_run = []
		await Walk(argv.testo_project_dir, (file_name) => {
			for (let item of cycle_items) {
				if (path.basename(file_name) == `${item.testCaseKey}.testo`) {
					files_to_run.push(file_name)
				}
			}
		})

		console.log('')

		console.log('Found the following matching .testo files:')

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

			throw new Error("Missing .testo files for the following tests:\n" + missing_tests)
		}

		let existing_test_runs = await GetTestRuns();

		if (argv.invalidate) {
			for (let i = 0; i < files_to_run.length; i++) {
				let file_to_run = files_to_run[i]
				let testo_args = []

				testo_args.push('run')
				testo_args.push(file_to_run)
				testo_args.push('--assume_yes')
				testo_args.push('--report_folder')
				testo_args.push(argv.report_folder)

				if (argv.prefix) {
					testo_args.push('--prefix')
					testo_args.push(argv.prefix)
				}

				if (argv.nn_server) {
					testo_args.push('--nn_server')
					testo_args.push(argv.nn_server)
				}

				if (argv.param) {
					for (let i = 0; i < argv.param.length; i++) {
						testo_args.push('--param')
						testo_args.push(argv.param[i])
						testo_args.push(argv.param[++i])
					}
				}

				testo_args.push('--invalidate')
				testo_args.push(argv.invalidate)
				testo_args.push('--dry')

				let testo_bin = 'testo'

				console.log(`Invalidating test ${i+1}/${files_to_run.length}: ${[testo_bin, ...testo_args].join(' ')} ...`)
				await RunProcess(testo_bin, testo_args)
			}

			console.log('')
		}

		let testo_report = await LoadReport(argv.report_folder)

		for (let i = 0; i < files_to_run.length; i++) {

			let existing_test = null
			let file_to_run = files_to_run[i]
			let launch = testo_report.findLaunchByFileName(file_to_run)

			//check if it's already been submitted
			let already_submitted = false;
			for (let j = 0; j < existing_test_runs.length; j++) {
				if (existing_test_runs[j].testCaseKey == path.parse(file_to_run).name) {
					if (launch && existing_test_runs[j].comment == launch.id) {
						//Already submitted
						console.log(`Omitting test ${i+1}/${files_to_run.length} because it's already been submitted ...`)
						already_submitted = true
						break
					} else {
						//That's the case we need to update
						existing_test = existing_test_runs[j]
						break
					}
				} 
			}

			if (already_submitted) {
				console.log('')
				continue
			}

			if (!launch) {

				let testo_args = []

				testo_args.push('run')
				testo_args.push(file_to_run)
				testo_args.push('--assume_yes')
				testo_args.push('--report_folder')
				testo_args.push(argv.report_folder)

				if (argv.prefix) {
					testo_args.push('--prefix')
					testo_args.push(argv.prefix)
				}

				if (argv.nn_server) {
					testo_args.push('--nn_server')
					testo_args.push(argv.nn_server)
				}

				if (argv.param) {
					for (let i = 0; i < argv.param.length; i++) {
						testo_args.push('--param')
						testo_args.push(argv.param[i])
						testo_args.push(argv.param[++i])
					}
				}

				let testo_bin = 'testo'

				console.log(`Running test ${i+1}/${files_to_run.length}: ${[testo_bin, ...testo_args].join(' ')} ...`)
				await RunProcess(testo_bin, testo_args)

				testo_report = await LoadReport(argv.report_folder)
				launch = testo_report.findLaunchByFileName(file_to_run)
			}			


			let output = ""

			let general_status = 'Pass'
			let screenshots = []

			for (let test_run of launch.tests_runs) {
				output += fs.readFileSync(path.join(test_run.report_folder, "log.txt"), 'utf8')

				await Walk(test_run.report_folder, (file_name) => {
					if (path.parse(file_name).ext == ".png") {
						screenshots.push(file_name)
					}
				})

				if (test_run.exec_status == 'failed') {
					general_status = 'Fail'
					break;
				}
			}

			if (launch.skipped_tests) {
				if (launch.skipped_tests.length > 0) {
					general_status = 'Blocked'
				}
			}

			output += fs.readFileSync(path.join(launch.report_folder, "log.txt"), 'utf8')

			let exec_id = null;

			if (existing_test) {
				console.log('Updating an existing test result ...')
				let update_request = {
					testCaseKey: path.parse(file_to_run).name,
					status: general_status,
					executionTime: Math.abs(Date.parse(launch.stop_timestamp) - Date.parse(launch.start_timestamp)),
					executionDate: launch.start_timestamp,
					executedBy: existing_test.assignedTo,
					comment: launch.id,
					scriptResults: []
				}

				for (let j = 0; j < existing_test.scriptResults.length; j++) {
					update_request.scriptResults.push({
						index: j,
						status: general_status
					})
				}

				update_request.scriptResults[update_request.scriptResults.length - 1].comment = output.replace(/\n/g, "<br>")

				exec_id = await UpdateTest(update_request)
			} else {
				console.log('Submitting a new test result ...')
				let submit_request = [
					{
						status: general_status,
						testCaseKey: path.parse(file_to_run).name,
						executionTime: Math.abs(Date.parse(launch.stop_timestamp) - Date.parse(launch.start_timestamp)),
						executionDate: launch.start_timestamp,
						executedBy: argv.username,
						comment: launch.id,
						scriptResults: [{
							index: 0,
							status: general_status,
							comment: output.replace(/\n/g, "<br>")
						}]
					}
				]

				exec_id = await SubmitTest(submit_request)
			}

			console.log('Attaching a summary output file to the test result ...')
			let attachment = new FormData();
			attachment.append('file', Buffer.from(output), {
				filename: 'summary_output.txt',
				contentType: 'text/html; charset=utf-8',
				knownLength: Buffer.from(output).length
			 });

			await AttachStuff(exec_id, attachment)

			for (let screenshot of screenshots) {
				console.log(`Attaching a screenshot ${screenshot} to the test result ...`)
				attachment = new FormData();
				attachment.append('file', fs.createReadStream(screenshot))
				await AttachStuff(exec_id, attachment)
			}

			console.log('')
		}

		console.log('All Done!')

	} catch (error) {
		console.log("ERROR:", error)
	}
}

main()
