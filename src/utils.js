
const child_process = require('child_process')
const axios = require('axios');
const fs = require('fs');
const path = require('path');

async function Walk(dir, cb)

module.exports.Walk = async function(dir, cb) {
	let files = await fs.promises.readdir(dir)
	for (let file of files) {
		let file_path = path.join(dir, file)
		let stat = await fs.promises.stat(file_path)
		if (stat.isDirectory()) {
			await Walk(file_path, cb)
		} else {
			cb(file_path)
		}
	}
}

module.exports.RunProcess = function(cmd, args) {
	return new Promise(function(resolve, reject) {
		let p = child_process.spawn(cmd, args)
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

function Sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports.SuperAxios = async function(args) {
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

class Report {
	constructor() {
		this.tests = []
		this.tests_runs = []
		this.launches = []
		this.tests_map = new Map()
		this.tests_runs_map = new Map()
		this.launches_map = new Map()
	}

	async init(report_folder) {
		report_folder = path.normalize(report_folder)

		let files = await fs.promises.readdir(report_folder)
		if (!files.length) {
			return
		}

		if (!files.includes(".testo_report_folder")) {
			throw `Directory ${report_folder} is not a testo report folder`
		}

		if (files.includes("tests")) {
			await this.loadItems(path.join(report_folder, "tests"), this.tests, this.tests_map)
		}

		if (files.includes("tests_runs")) {
			await this.loadItems(path.join(report_folder, "tests_runs"), this.tests_runs, this.tests_runs_map)
		}

		if (files.includes("launches")) {
			await this.loadItems(path.join(report_folder, "launches"), this.launches, this.launches_map)
		}

		this.postprocessTests()
		this.postprocessTestsRuns()
		this.postprocessLaunches()
	}

	async loadItems(items_dir, list, map) {
		let items_ids = await fs.promises.readdir(items_dir)
		for (let item_id of items_ids) {
			let item_dir = path.join(items_dir, item_id)
			let stat = await fs.promises.stat(item_dir)
			if (!stat.isDirectory()) {
				continue
			}
			let meta_path = path.join(item_dir, "meta.json")
			let meta = JSON.parse(await fs.promises.readFile(meta_path, 'utf8'))
			meta.report_folder = item_dir
			meta["id"] = item_id
			list.push(meta)
			map.set(item_id, meta)
		}
	}

	postprocessTests() {
	}

	postprocessTestsRuns() {
	}

	postprocessLaunches() {
		for (let launch of this.launches) {
			let tests_runs = []
			for (let id of launch.tests_runs) {
				tests_runs.push(this.tests_runs_map.get(id))
			}
			launch.tests_runs = tests_runs

			let up_to_date_tests = []
			for (let id of launch.up_to_date_tests) {
				up_to_date_tests.push(this.tests_map.get(id))
			}
			launch.up_to_date_tests = up_to_date_tests
		}
	}

	findLaunchByFileName(file_name) {
		for (let launch of this.launches) {
			if (launch.config.target == file_name) {
				return launch
			}
		}
		return null
	}
}

module.exports.LoadReport = async function(report_folder) {
	let report = new Report()
	await report.init(report_folder)
	return report
}
