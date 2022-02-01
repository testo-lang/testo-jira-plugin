
const {SuperAxios} = require('./utils')
const FormData = require('form-data')

class JIRA {
	constructor({username, password, jira_url, cycle}) {
		this.credentials = {
			username,
			password
		}

		if (jira_url[jira_url.length - 1] == "/") {
			jira_url = jira_url.substr(0, jira_url.length - 1)
		}

		this.jira_rest_endpoint = jira_url + "/rest/atm/1.0"
		this.cycle = cycle
	}

	async GetCycleItems() {
		const response = await SuperAxios(() => {
			return {
				method: 'get',
				url: `${this.jira_rest_endpoint}/testrun/${this.cycle}`,
				auth: this.credentials
			}
		})
		return response.data.items
	}

	async GetTestResults() {
		let response = await SuperAxios(() => {
			return {
				method: 'get',
				url: `${this.jira_rest_endpoint}/testrun/${this.cycle}/testresults/`,
				auth: this.credentials
			}
		})
		return response.data
	}

	async GetTestResult(test_result_id) {
		let results = await this.GetTestResults()
		for (let result of results) {
			if (result.id == test_result_id) {
				return result;
			}
		}
		throw `Failed to find a test result with id ${test_result_id}`
	}

	async CreateNewTestResult(report) {
		let response = await SuperAxios(() => {
			return {
				method: 'post',
				url: `${this.jira_rest_endpoint}/testrun/${this.cycle}/testresults/`,
				data: report,
				auth: this.credentials
			}
		})
		return response.data[0].id
	}

	async UpdateLastTestResult(test_case_key, report) {
		let response = await SuperAxios(() => {
			return {
				method: 'put',
				url: `${this.jira_rest_endpoint}/testrun/${this.cycle}/testcase/${test_case_key}/testresult`,
				data: report,
				auth: this.credentials
			}
		})
		return response.data.id
	}

	async Attach(exec_id, generate_attachment) {
		let response = await SuperAxios(() => {
			let attachment = generate_attachment()
			return {
				method: 'post',
				url: `${this.jira_rest_endpoint}/testresult/${exec_id}/attachments`,
				data: attachment,
				auth: this.credentials,
				headers: attachment.getHeaders()
			}
		})
	}

	async AttachTextFile(exec_id, filename, binary_text) {
		await this.Attach(exec_id, () => {
			let attachment = new FormData()
			attachment.append('file', binary_text, {
				filename,
				contentType: 'text/html; charset=utf-8',
				knownLength: binary_text.length
			})
			return attachment
		})
	}

	async AttachImage(exec_id, filename, binary_img) {
		await this.Attach(exec_id, () => {
			let attachment = new FormData()
			attachment.append('file', binary_img, {
				filename,
				contentType: 'image/png',
				knownLength: binary_img.length
			})
			return attachment
		})
	}
}

module.exports = JIRA
