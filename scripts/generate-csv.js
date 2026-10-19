// Generates a CSV with N fake leads for performance testing: node scripts/generate-csv.js 150 > leads-150.csv
const count = Number(process.argv[2] || 150);
const statuses = ['Mới', 'Đang xử lý', 'Đã xử lý'];
const sources = ['website', 'facebook', 'event', 'partner'];
const rows = ['Tên khách hàng,Email,Số điện thoại,Công ty,Nguồn lead,Ngân sách dự kiến,Trạng thái,Người phụ trách,Ghi chú'];
for (let i = 1; i <= count; i++) {
  const n = String(i).padStart(4, '0');
  rows.push([
    `Khách hàng ${n}`, `perf.lead${n}@example.com`, `09${String(10000000 + i)}`, `Công ty ${n}`,
    sources[i % sources.length], (i % 10 + 1) * 10000000, statuses[i % statuses.length], 'Admin', `Lead test hiệu năng #${i}`,
  ].join(','));
}
console.log(rows.join('\n'));
