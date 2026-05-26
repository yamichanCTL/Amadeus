package com.asrapp.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import com.asrapp.android.ui.AsrApp
import com.asrapp.android.ui.AsrTheme
import com.asrapp.android.ui.MainViewModel

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val viewModel: MainViewModel = viewModel()
            AsrTheme {
                AsrApp(viewModel)
            }
        }
    }
}
