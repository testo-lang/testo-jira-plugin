#!/usr/bin/node

const fs = require('fs');
const winston = require('winston')
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
	.describe('license', 'license file to pass into Testo')
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
	.nargs('license', 1)
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

logger = winston.createLogger({
	transports: [
		new winston.transports.Console({
			format: winston.format.printf(info => info.message)
		}),
		new winston.transports.File({
			filename: path.join(argv.report_folder, "testo-tm4j.log"),
			level: 'debug',
			format: winston.format.combine(
				winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
				winston.format.errors({ stack: true }),
				winston.format.splat(),
				winston.format.printf(function ({timestamp, level, message, ...rest}) {
					let stringifiedRest = JSON.stringify(rest)
					if (stringifiedRest !== "{}") {
						return `${timestamp} ${level} ${message} ${JSON.stringify(rest)}`
					} else {
						return `${timestamp} ${level} ${message}`
					}
				})
			)
		})
	]
});

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
	logger.debug("============================================== BEGIN ==============================================")

	logger.debug("Original args: %j", process.argv)
	logger.debug("Parsed args: %j", argv)

	let package_json_path = path.join(__dirname, '..', 'package.json')
	let package_json = JSON.parse(fs.readFileSync(package_json_path, 'utf8'))
	logger.debug("Package json: %j", package_json)
	logger.debug('')

	try {
		logger.info(`Getting cycle ${argv.cycle} info from Jira...`);
		const cycle_items = await GetCycleItems()
		logger.debug("Cycle items: %j", cycle_items)
		logger.info('Success');

		logger.info('')

		let tests_to_run = []
		logger.info("Found the following test cases:")
		for (let item of cycle_items) {
			tests_to_run.push(item.testCaseKey)
			logger.info(`\t- ${item.testCaseKey}`)
		}

		let files_to_run = []
		await Walk(argv.testo_project_dir, (file_name) => {
			for (let item of cycle_items) {
				if (path.basename(file_name) == `${item.testCaseKey}.testo`) {
					files_to_run.push(file_name)
				}
			}
		})

		logger.info('')

		logger.info('Found the following matching .testo files:')

		for (let file of files_to_run) {
			logger.info(`\t-${file}`)
		}

		logger.info('')

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
		logger.debug("Existing test runs: %j", existing_test_runs)

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

				testo_args.push('--invalidate')
				testo_args.push(argv.invalidate)
				testo_args.push('--dry')

				let testo_bin = 'testo'

				logger.info(`Invalidating tests ${i+1}/${files_to_run.length}: ${[testo_bin, ...testo_args].join(' ')}`)
				await RunProcess(testo_bin, testo_args)
				logger.info('')
			}
		}

		let testo_report = await LoadReport(argv.report_folder)

		for (let i = 0; i < files_to_run.length; i++) {
			let file_to_run = files_to_run[i]
			let launch = testo_report.findLaunchByFileName(file_to_run)

			let already_submitted = false;

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

				let testo_bin = 'testo'

				logger.info(`Running test ${i+1}/${files_to_run.length}: ${[testo_bin, ...testo_args].join(' ')}`)
				await RunProcess(testo_bin, testo_args)

				testo_report = await LoadReport(argv.report_folder)
				launch = testo_report.findLaunchByFileName(file_to_run)
			} else {
				//check if it's already been submitted
				for (let j = 0; j < existing_test_runs.length; j++) {
					if (existing_test_runs[j].comment == launch.id) {
						logger.info(`Omitting test ${i+1}/${files_to_run.length} because it's already been submitted`)
						already_submitted = true
						break
					}
				}
			}

			if (already_submitted) {
				logger.info('')
				continue
			}

			logger.debug("Launch ID: %s", launch.id)

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

			output += fs.readFileSync(path.join(launch.report_folder, "log.txt"), 'utf8')

			logger.info('Submitting results to Jira...')

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

			logger.debug("Submit request: %j", submit_request)
			let exec_id = await SubmitTest(submit_request)
			logger.debug("Exec ID: %s", exec_id)

			logger.info('Created Jira test result with id ' + exec_id)

			let attachment = new FormData();
			attachment.append('file', Buffer.from(output), {
				filename: 'summary_output.txt',
				contentType: 'text/html; charset=utf-8',
				knownLength: Buffer.from(output).length
			 });

			await AttachStuff(exec_id, attachment)
			logger.info('Attached summary output file to the test result ' + exec_id)

			for (let screenshot of screenshots) {
				attachment = new FormData();
				attachment.append('file', fs.createReadStream(screenshot))
				await AttachStuff(exec_id, attachment)
				logger.info(`Attached screenshot ${screenshot} to the test result ${exec_id}`)
			}

			logger.info('')
		}

		let final_test_runs = await GetTestRuns();
		logger.debug("Final test runs: %j", final_test_runs)

		logger.info('All Done!')

	} catch (error) {
		logger.error("ERROR:", error)
	}

	logger.debug("============================================== END ==============================================")
	logger.end()
}

main()
