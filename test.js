try {
    const lib = require('اسم-المكتبة')
    console.log('✅ المكتبة تعمل بنجاح')
} catch (error) {
    console.log('❌ المكتبة لا تعمل')
    console.error(error.message)
}
