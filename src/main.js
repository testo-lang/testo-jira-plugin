#!/usr/bin/node

const fs = require('fs');
const path = require('path')
const crypto = require("crypto")
const {Walk, RunProcess, CreateTcpServer} = require('./utils')
const JIRA = require("./jira")

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
	.nargs('jira_url', 1)
	.nargs('username', 1)
	.nargs('password', 1)
	.nargs('cycle', 1)
	.nargs('testo_project_dir', 1)
	.nargs('param', 2)
	.nargs('nn_server', 1)
	.nargs('prefix', 1)
	.nargs('invalidate', 1)
	.argv;

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

let jira = new JIRA(argv)

async function CheckTestoVersion() {
	console.log('Checking testo version ...')

	let version_output = await RunProcess('testo', ['version'])
	let version_re = /(\d+).(\d+).(\d+)/
	let match = version_output.match(version_re)
	let major = match[1]
	let minor = match[2]
	let patch = match[3]
	if (major < 3 || (major == 3 && minor < 3)) {
		console.log('Testo client has an incompatible version. You should update it to the version 3.3.0 or higher')
		process.exit(1)
	}
}

function GetTestCaseKey(file_path) {
	return path.parse(file_path).name
}

async function GetFilesToRun() {
	console.log(`Getting cycle ${argv.cycle} info from Jira ...`);

	const cycle_items = await jira.GetCycleItems()

	console.log('')

	console.log("Found the following test cases:")
	for (let item of cycle_items) {
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

	if (files_to_run.length != cycle_items.length) {
		let missing_tests = ""

		for (let item of cycle_items) {
			found = false
			for (let file of files_to_run) {
				if (GetTestCaseKey(file) == item.testCaseKey) {
					found = true
					break
				}
			}
			if (!found) {
				missing_tests += "\t- " + item.testCaseKey + "\n"
			}
		}

		throw new Error("Missing .testo files for the following tests:\n" + missing_tests)
	}

	return files_to_run
}

async function CreateLaunchScript(files_to_run) {
	console.log(`Generating the launch script ...`)

	let path = "/tmp/testo_tm4j_launch_" + crypto.randomBytes(5).toString('hex')
	let stream = fs.createWriteStream(path)
	for (let file of files_to_run) {
		stream.write(`include "${file}"\n`)
	}
	stream.end()
	return path
}

async function LaunchTesto(launch_script, tcp_port) {
	console.log(`Launching testo ...`);

	let testo_args = []

	testo_args.push('run')
	testo_args.push(launch_script)
	testo_args.push('--assume_yes')

	testo_args.push('--report_format')
	testo_args.push("native_remote")
	testo_args.push('--report_folder')
	testo_args.push(`127.0.0.1:${tcp_port}`)

	if (argv.prefix) {
		testo_args.push('--prefix')
		testo_args.push(argv.prefix)
	}

	if (argv.nn_server) {
		testo_args.push('--nn_server')
		testo_args.push(argv.nn_server)
	}

	if (argv.invalidate) {
		testo_args.push('--invalidate')
		testo_args.push(argv.invalidate)
	}

	if (argv.param) {
		for (let i = 0; i < argv.param.length; i++) {
			testo_args.push('--param')
			testo_args.push(argv.param[i])
			testo_args.push(argv.param[++i])
		}
	}

	let testo_bin = 'testo'

	// console.log(testo_bin + " " + testo_args.join(" "))

	await RunProcess(testo_bin, testo_args)
}

function TrimBR(str) {
	while (str.startsWith("<br>")) {
		str = str.slice("<br>".length)
	}
	while (str.endsWith("<br>")) {
		str = str.slice(0, -"<br>".length)
	}
	return str
}

let tests = new Map()
let jtests = new Map()

class Test {
	constructor(obj) {
		Object.assign(this, obj)
	}
	populateStatistics(stats) {
		for (let parent_name of this.parents) {
			let parent = tests.get(parent_name)
			parent.populateStatistics(stats)
		}
		if (this.cache_status == 'ok') {
			stats.up_to_date.add(this.name)
			return
		}
		if (!this.last_test_run) {
			stats.in_progress.add(this.name)
			return
		}
		switch (this.last_test_run.exec_status) {
			case "unknown":
				stats.in_progress.add(this.name)
				break;
			case "passed":
				stats.passed.add(this.name)
				break;
			case "failed":
				if (this.last_test_run.failure_category == 'logic_error') {
					stats.failed_with_logic_error.add(this.name)
				} else {
					stats.failed_with_other_error.add(this.name)
				}
				break;
			case "skipped":
				stats.skipped.add(this.name)
				break;
		}
	}
}

class JTest {
	constructor(source_file) {
		this.source_file = source_file
		this.test_case_key =  GetTestCaseKey(source_file)
		this.tests = []
	}
	getStatistics() {
		let stats = {
			in_progress: new Set(),
			skipped: new Set(),
			failed_with_logic_error: new Set(),
			failed_with_other_error: new Set(),
			passed: new Set(),
			up_to_date: new Set(),
		}
		for (let test of this.tests) {
			test.populateStatistics(stats)
		}
		return stats
	}
	getStatus() {
		let stats = this.getStatistics()
		if (stats.in_progress.size != 0) {
			return "In Progress"
		} else if (stats.skipped.size != 0) {
			return "Blocked"
		} else if (stats.failed_with_logic_error.size != 0) {
			return "Irrelevant"
		} else if (stats.failed_with_other_error.size != 0) {
			return "Fail"
		} else {
			return "Pass"
		}
	}
	async touch() {
		this.exec_id = await jira.UpdateLastTestResult(this.test_case_key, {
			status: this.getStatus(),
		})
	}
	async update(output) {
		let exec = await jira.GetTestResult(this.exec_id)
		let comment = ""
		if (exec.comment) {
			comment += TrimBR(exec.comment) + "<br><br>---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------<br><br>";
		}
		comment += output.trim().replace(/\n/g, "<br>")
		this.exec_id = await jira.UpdateLastTestResult(this.test_case_key, {
			comment,
			status: this.getStatus()
		})
	}
	async attachOutput(name, output) {
		await jira.AttachTextFile(this.exec_id, name, Buffer.from(output))
	}
	async attachScreenshot(name, screenshot) {
		await jira.AttachImage(this.exec_id, name, Buffer.from(screenshot))
	}
};

async function InitGlobalTestMap(files_to_run) {
	console.log("Initializing the global test's registry ...")
	for (let file of files_to_run) {
		jtests.set(file, new JTest(file))
	}
}

async function HandleLaunchBegin(msg) {
	console.log("Getting the list of all testo tests ...")
	for (let test of msg.tests) {
		test = new Test(test)
		tests.set(test.name, test)
		if (jtests.has(test.source_file)) {
			jtests.get(test.source_file).tests.push(test)
		}
	}
	console.log("Checking if any jira tests are already up-to-date ...")
	for (const [file, jtest] of jtests) {
		if (jtest.getStatus() != "In Progress") {
			console.log(`Skipping test case ${GetTestCaseKey(file)} because it's already up-to-date ...`)
		}
	}
}

async function HandleTestSkipBegin(msg) {
	const test = tests.get(msg.current_test_run.test_name)
	const jtest = jtests.get(test.source_file)

	test.last_test_run = msg.current_test_run
	test.output = ""

	// do not print anything

	if (jtest) {
		await jtest.touch()
	}
}

async function HandleTestSkipEnd(msg) {
	const test = tests.get(msg.current_test_run.test_name)
	const jtest = jtests.get(test.source_file)

	test.last_test_run = msg.current_test_run

	if (jtest) {
		console.log(`Skipping test ${test.name} from file ${path.basename(test.source_file)} because some of its parents had failed. Uploading results ...`)
		await jtest.update(test.output)
	} else {
		console.log(`Skipping test ${test.name} from file ${path.basename(test.source_file)} because some of its parents had failed.`)
	}
}

async function HandleTestBegin(msg) {
	const test = tests.get(msg.current_test_run.test_name)
	const jtest = jtests.get(test.source_file)

	test.last_test_run = msg.current_test_run
	test.output = ""

	console.log(`Running test ${test.name} from file ${path.basename(test.source_file)} ...`)

	if (jtest) {
		await jtest.touch()
	}
}

async function HandleReport(msg) {
	if (!msg.hasOwnProperty('current_test_run')) {
		return
	}
	// do not print anything

	const test = tests.get(msg.current_test_run.test_name)
	test.output += msg.text
}

async function HandleReportScreenshot(msg) {
	if (!msg.hasOwnProperty('current_test_run')) {
		return
	}

	const test = tests.get(msg.current_test_run.test_name)
	const jtest = jtests.get(test.source_file)

	if (jtest) {
		console.log("Uploading screenshot ...")
		await jtest.attachScreenshot(test.name + "_screenshot.png", msg.screenshot)
	}
}

async function HandleTestEnd(msg) {
	const test = tests.get(msg.current_test_run.test_name)
	const jtest = jtests.get(test.source_file)

	test.last_test_run = msg.current_test_run

	if (jtest) {
		console.log(`The test has finished with status "${msg.current_test_run.exec_status}". Uploading results ...`)
		await jtest.update(test.output)
		await jtest.attachOutput(test.name + "_output.txt", test.output)
	} else {
		console.log(`The test has finished with status "${msg.current_test_run.exec_status}".`)
	}
}

async function HandleLaunchEnd(msg) {
	console.log("All tests are finished. Cleaning up ...")
}

async function ReceiveDataFromTesto(server) {
	console.log(`Waiting for a tcp connection from testo ...`);
	let socket = await server.accept();

	console.log(`Receiving initial information from testo ...`);
	let all_done = false
	while (!all_done) {
		let msg = await socket.recv();
		switch (msg.type) {
			case "launch_begin":
				await HandleLaunchBegin(msg)
				break
			case "test_skip_begin":
				await HandleTestSkipBegin(msg)
				break
			case "test_skip_end":
				await HandleTestSkipEnd(msg)
				break
			case "test_begin":
				await HandleTestBegin(msg)
				break
			case "report":
				await HandleReport(msg)
				break
			case "report_screenshot":
				await HandleReportScreenshot(msg)
				break
			case "test_end":
				await HandleTestEnd(msg)
				break
			case "launch_end":
				await HandleLaunchEnd(msg)
				all_done = true
				break;
			default:
				throw "Invalid msg type from testo reporter: " + msg.type
		}
		socket.send({type: "confirmation"})
	}
}

async function main() {
	try {
		await CheckTestoVersion()
		let files_to_run = await GetFilesToRun()
		await InitGlobalTestMap(files_to_run)
		let launch_script = await CreateLaunchScript(files_to_run)
		let server = await CreateTcpServer()
		await Promise.all([
			LaunchTesto(launch_script, server.address().port),
			ReceiveDataFromTesto(server)
		])
		console.log('All Done!')
		process.exit(0)
	} catch (error) {
		console.log("ERROR:", error)
		process.exit(1)
	}
}

main()
